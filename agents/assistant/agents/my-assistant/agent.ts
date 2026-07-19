import { callable } from "agents";
import {
  Think,
  Session,
  skills,
  defaultContextOverflowClassifier
} from "@cloudflare/think";
import bundledSkills from "agents:skills";
import type { WorkspaceFsLike } from "@cloudflare/shell";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";
import { createQuickActionTools } from "@cloudflare/think/tools/browser";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { AgentSearchProvider } from "agents/experimental/memory/session";
import type {
  TurnContext,
  TurnConfig,
  ChatResponseResult,
  ToolCallContext,
  ToolCallResultContext,
  StepContext
} from "@cloudflare/think";
import { tool, generateText } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { AssistantDirectory } from "../../agent";
import { SharedMCPClient } from "../../shared-mcp-client";
import { SharedWorkspace } from "../../shared-workspace";
import type { AgentConfig } from "../../types";
import { createGatewayModel } from "../../gateway-model";

interface StoryDirectoryRpc {
  getStoryState(): Promise<unknown>;
  getStoryWorkspace(): Promise<unknown>;
  getStoryDiff(): Promise<unknown>;
  getStoryHistory(limit?: number, beforeId?: number): Promise<unknown>;
  updateStoryWorkspace(input: {
    story: unknown;
    expectedRevision: number;
    actor: string;
    source: "agent";
    summary?: string;
  }): Promise<unknown>;
  restoreStoryVersionToWorkspace(
    sha: string,
    actor: string
  ): Promise<unknown>;
  restoreStoryEventToWorkspace(
    eventId: number,
    expectedRevision: number,
    actor: string
  ): Promise<unknown>;
}

// ── MyAssistant — one Think DO per chat (a facet of the directory) ────

export class MyAssistant extends Think<Env> {
  static options = {
    sendIdentityOnConnect: true
  };
  override maxSteps = 10;
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  /**
   * Opt-in, read-only HTTP fetch. Registers a `fetch_url` tool so the model
   * can read pages/APIs directly without spinning up the browser. This demo
   * allows any public URL (`http(s)://**`); a real app should narrow this to
   * the origins it actually needs. Note that even with a wildcard allowlist,
   * the framework still refuses private/loopback/`*.internal` targets (SSRF
   * defense) — that protection is independent of the allowlist.
   *
   * Think injects `this.workspace` automatically, so with `spillToWorkspace` a
   * large or binary response is written into the shared workspace (and shows
   * up in the file browser) instead of bloating the transcript. The
   * markdown-first default `Accept` nudges content-negotiating endpoints
   * toward clean markdown. Per-tenant allowlists would build this in
   * `getTools()` instead; a static list is fine here.
   */
  fetchTools = {
    allowlist: ["https://**", "http://**"],
    spillToWorkspace: true
  };

  /**
   * Override Think's default per-chat workspace with a proxy into the
   * shared `AssistantDirectory.workspace`. This class field runs in the
   * subclass's synthetic constructor after `super(ctx, env)`, so by the
   * time Think's wrapped `onStart` fires its `!this.workspace` default-
   * init check, the shared proxy is already in place — Think never
   * creates a per-chat `Workspace` at all.
   *
   * Declared as `WorkspaceFsLike` (the wider interface from
   * `@cloudflare/shell`) rather than Think's `WorkspaceLike` so that
   * `createWorkspaceStateBackend(this.workspace)` in `getTools()` sees
   * the full filesystem surface it needs. `WorkspaceFsLike` is a strict
   * superset of `WorkspaceLike`, so Think's internals keep working.
   *
   * All workspace-aware code — the builtin tools from
   * `createWorkspaceTools`, lifecycle hooks, the `listWorkspaceFiles`
   * / `readWorkspaceFile` RPCs below, and codemode's `state.*` sandbox
   * API via `createWorkspaceStateBackend` — routes through this proxy
   * transparently.
   */
  override workspace: WorkspaceFsLike = new SharedWorkspace(() =>
    this.parentAgent(AssistantDirectory)
  );

  /**
   * Proxy to the directory's MCP state. Used by `beforeTurn` below to
   * splice the user's shared MCP tools into each turn's tool set.
   *
   * The child's own `this.mcp` (Think's default) stays around but is
   * never registered against — it exists solely so Agent framework
   * paths that reach for `this.mcp.*` (hibernation restore, OAuth
   * callback routing, broadcast plumbing) don't need to care about
   * the parallel-field arrangement. Those paths all resolve to an
   * empty, idle MCP client.
   *
   * OAuth callbacks (`/chat/mcp-callback`) are routed to the parent
   * directory by the Worker, never to a child, so child-side
   * `isCallbackRequest` in the framework reliably returns false here.
   */
  sharedMcp = new SharedMCPClient(() => this.parentAgent(AssistantDirectory));

  getModel() {
    return createGatewayModel(this.env);
  }

  private async getStoryDirectory(): Promise<StoryDirectoryRpc> {
    return (await this.parentAgent(
      AssistantDirectory
    )) as unknown as StoryDirectoryRpc;
  }

  // Recover from a turn that overflows the context window mid-flight: compaction
  // (configured in configureSession below) is only checked between turns, so a
  // long, tool-heavy turn can grow past the window before the next check. With
  // `reactive` on, such a turn is compacted and re-run instead of dying.
  override contextOverflow = { reactive: true };

  // Think ships no provider-specific error matching — teach it which errors are
  // context-window overflows. The bundled defaultContextOverflowClassifier
  // covers the common providers; assign it directly, or wrap it to add your own
  // categories.
  override classifyChatError = defaultContextOverflowClassifier;

  // Bundled Agent Skills colocated under `./skills` (resolved through the
  // `agents:skills` specifier). The model advertises the skill catalog in
  // its prompt and activates a skill on demand via `activate_skill` rather
  // than carrying every instruction in every turn.
  getSkills() {
    return [bundledSkills];
  }

  // Lets skills expose runnable scripts (`run_skill_script`). Scripts run in
  // a bounded Worker via the Worker Loader, with read-only access to this
  // chat's shared workspace so a script can inspect saved files.
  getSkillScriptRunner() {
    return skills.runner({
      loader: this.env.LOADER,
      workspaceInstance: this.workspace
    });
  }

  configureSession(session: Session) {
    const persona =
      this.getConfig<AgentConfig>()?.persona ||
      "You are a capable technical assistant. You have access to a persistent workspace, sandboxed code execution, a real browser you can drive over the Chrome DevTools Protocol (the `cdp.*` namespace inside execute), stateless one-shot browsing tools (browser_markdown, browser_extract, browser_links, browser_scrape), a `fetch_url` tool for reading allowlisted web pages and APIs directly, and the ability to create new tools on the fly. You think before you act, and you prefer writing code over making many sequential tool calls.";

    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            `${persona}

Be concise. Prefer short, direct answers over lengthy explanations.
The execute tool runs JavaScript you write in a sandboxed environment. Use it for multi-file operations, data transformations, or any task that would require many sequential tool calls. Inside that sandbox the only globals are the connector namespaces listed in the tool description (e.g. \`state.*\` for workspace files, \`tools.*\` for your tools) plus \`codemode\` — there is no \`host\` object, \`fs\`, or Node.js API.
For reading a known URL or API, prefer the \`fetch_url\` tool — it is a fast, read-only HTTP GET over any public URL, and large responses spill to the workspace. For rendered pages, link discovery, or AI extraction, use the one-shot Quick Action tools — \`browser_markdown\` to read a page, \`browser_extract\` to pull structured data, \`browser_links\` to list links, \`browser_scrape\` to grab elements — and only reach for the interactive \`cdp.*\` API inside execute when you need to click, type, or navigate across multiple steps.
When a question concerns an uploaded document, use \`search_documents\` with a focused query even if the user did not repeat its document_id. Pass documentIds when a specific id is known; otherwise search the user's ready documents. Retrieve only the evidence needed for the question, cite each answer with the returned citation label, and never load an entire PDF or large text into model context.
You can create extensions: new tools that persist across conversations. Offer to create one when a recurring task would benefit from it.
When you learn something about the user or their project, save it to memory.`
        }
      })
      .withContext("story-workspace", {
        provider: {
          get: async () => {
            // Unit tests and story-disabled deployments intentionally omit
            // GitHub App bindings. Avoid a failing parent RPC during every
            // chat startup in those environments.
            if (
              !this.env.STORY_GITHUB_APP_ID ||
              !this.env.STORY_GITHUB_INSTALLATION_ID ||
              !this.env.STORY_GITHUB_PRIVATE_KEY
            ) {
              return "The story workspace is not configured in this environment. Story tools are unavailable; do not guess story state or claim to have changed it.";
            }
            try {
              const directory = await this.getStoryDirectory();
              const state = await directory.getStoryState();

              return `The current story workspace is shared by the user interface and every chat. Its live state is:
${JSON.stringify(state, null, 2)}

Treat the repository, branch, HEAD, workspace revision, dirty status, and restored-from fields above as dynamic facts, not facts from chat history. Call get_story_workspace before changing story data and pass its latest revision to update_story_workspace. Use get_story_history to answer version questions or choose either a Git commit SHA or workspace event ID for restoration. Agent changes and historical restores only update the uncommitted workspace. They never create a GitHub commit or pull request. The user must inspect the visual diff and explicitly confirm a commit in the UI. Never claim that a workspace change has been committed.`;
            } catch (error) {
              console.warn(
                "[MyAssistant] Failed to load story workspace context:",
                error
              );
              return "The live story workspace state is currently unavailable. Do not guess its repository, branch, HEAD, revision, dirty status, or content. Ask the user to retry after the workspace is available.";
            }
          }
        }
      })
      .withContext("memory", {
        description:
          "Key facts about the user, their preferences, project context, and decisions made during conversation. Update when you learn something that would be useful in future turns.",
        maxTokens: 2000
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.resolveModel(), prompt }).then(
              (r) => r.text
            )
        })
      )
      .compactAfter(50000)
      .withContext("knowledge", {
        description:
          "Searchable knowledge base. Index useful information with set_context and retrieve it later with search_context.",
        provider: new AgentSearchProvider(this)
      })
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    const extensionTools = this.extensionManager
      ? {
          ...createExtensionTools({ manager: this.extensionManager }),
          ...this.extensionManager.getTools()
        }
      : {};

    return {
      // Agent one-liner with overrides: the executor comes from
      // `env.LOADER`, `cdp.*` from `env.BROWSER` (if bound), and `state.*`
      // inside the sandbox is backed by the SHARED workspace — the
      // `SharedWorkspace` proxy satisfies `WorkspaceFsLike`, so
      // `state.planEdits`/`applyEdits` in chat B sees and mutates the same
      // files chat A just wrote. This also assigns `this.codemode`, which
      // powers the built-in `approveExecution` / `rejectExecution` /
      // `pendingExecutions` callables behind the approval card.
      execute: createExecuteTool(this, {
        tools: {
          ...createWorkspaceTools(this.workspace),
          // Approval-gated sandbox tool: calling it pauses the run durably
          // and renders the approval card in the client. Approving resumes
          // the run exactly where it stopped.
          sendAnnouncement: tool({
            description:
              "Send an announcement to the team channel. Requires human approval before it goes out.",
            inputSchema: z.object({
              message: z.string().describe("The announcement text")
            }),
            needsApproval: true,
            execute: async ({ message }) => ({
              sent: true,
              message
            })
          })
        }
      }),

      ...extensionTools,

      // Stateless one-shot browsing (no CDP session, no sandbox): read a page
      // as Markdown, extract structured data with AI, list links, or scrape
      // elements. Complements the interactive `cdp.*` inside `execute` above —
      // the model picks Quick Actions for simple reads and `execute` for
      // multi-step automation. Shares the same `BROWSER` binding.
      ...createQuickActionTools({ browser: this.env.BROWSER }),

      search_documents: tool({
        description:
          "Search the user's uploaded PDFs and large text files. Returns only relevant chunks within a strict context budget, with citation labels. Use documentIds when the user refers to a specific uploaded document.",
        inputSchema: z.object({
          query: z.string().min(1).describe("Focused search query"),
          documentIds: z
            .array(z.string())
            .max(50)
            .optional()
            .describe("Optional uploaded document ids to search"),
          limit: z.number().int().min(1).max(20).optional().default(8),
          maxTokens: z
            .number()
            .int()
            .min(200)
            .max(12_000)
            .optional()
            .default(8_000)
        }),
        execute: async ({ query, documentIds, limit, maxTokens }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.searchDocuments(query, {
            documentIds,
            limit,
            maxTokens
          });
        }
      }),

      get_story_state: tool({
        description:
          "Read the latest lightweight story state, including repository, draft branch, GitHub HEAD, workspace revision, and whether uncommitted changes exist. Use this before story operations; it does not commit anything.",
        inputSchema: z.object({}),
        execute: async () => {
          const directory = await this.getStoryDirectory();
          return directory.getStoryState();
        }
      }),

      get_story_workspace: tool({
        description:
          "Read the latest shared, uncommitted story workspace and its revision. This is the source of truth for what the user and agents are currently editing, even when it differs from GitHub HEAD.",
        inputSchema: z.object({}),
        execute: async () => {
          const directory = await this.getStoryDirectory();
          return directory.getStoryWorkspace();
        }
      }),

      get_story_diff: tool({
        description:
          "Read the current uncommitted story diff against the draft branch HEAD. Use it to explain pending changes. A diff is only a proposal until the user confirms a commit in the UI.",
        inputSchema: z.object({}),
        execute: async () => {
          const directory = await this.getStoryDirectory();
          return directory.getStoryDiff();
        }
      }),

      get_story_history: tool({
        description:
          "List both Git commits and Durable Object workspace revisions, including the exact current HEAD/revision and restore provenance. Pass nextBeforeId back as beforeId to page through older revisions before restoring one.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(100).optional().default(50),
          beforeId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Cursor returned as nextBeforeId by the previous history page")
        }),
        execute: async ({ limit, beforeId }) => {
          const directory = await this.getStoryDirectory();
          return directory.getStoryHistory(limit, beforeId);
        }
      }),

      update_story_workspace: tool({
        description:
          "Replace the shared uncommitted story workspace with a complete updated story. Read get_story_workspace first and pass its latest revision as expectedRevision. This creates a reviewable pending diff only: it does not commit or open a pull request, and the user must explicitly confirm any GitHub commit in the UI.",
        inputSchema: z.object({
          story: z
            .unknown()
            .describe("Complete story DSL value for the updated workspace"),
          expectedRevision: z
            .number()
            .int()
            .nonnegative()
            .describe("Latest workspace revision returned by a read tool"),
          summary: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .optional()
            .describe("Short human-readable reason for this pending change")
        }),
        execute: async ({ story, expectedRevision, summary }) => {
          const directory = await this.getStoryDirectory();
          return directory.updateStoryWorkspace({
            story,
            expectedRevision,
            actor: `agent:${this.name}`,
            source: "agent",
            summary
          });
        }
      }),

      restore_story_version_to_workspace: tool({
        description:
          "Load a historical GitHub story version into the shared uncommitted workspace for review. This does not move the branch or create a commit. The user must inspect the resulting visual diff and explicitly confirm a commit in the UI.",
        inputSchema: z.object({
          sha: z
            .string()
            .trim()
            .min(7)
            .max(64)
            .describe("Historical commit SHA to load into the workspace")
        }),
        execute: async ({ sha }) => {
          const directory = await this.getStoryDirectory();
          return directory.restoreStoryVersionToWorkspace(
            sha,
            `agent:${this.name}`
          );
        }
      }),

      restore_story_revision_to_workspace: tool({
        description:
          "Restore a Durable Object workspace revision snapshot by event ID into the current uncommitted workspace. Call get_story_history first, choose an event with hasSnapshot=true, and pass the latest current revision. This creates a new auditable restore revision and never commits GitHub.",
        inputSchema: z.object({
          eventId: z.number().int().positive(),
          expectedRevision: z.number().int().nonnegative()
        }),
        execute: async ({ eventId, expectedRevision }) => {
          const directory = await this.getStoryDirectory();
          return directory.restoreStoryEventToWorkspace(
            eventId,
            expectedRevision,
            `agent:${this.name}`
          );
        }
      }),

      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name")
        }),
        execute: async ({ city }) => {
          const conditions = ["sunny", "cloudy", "rainy", "snowy"];
          const temp = Math.floor(Math.random() * 30) + 5;
          return {
            city,
            temperature: temp,
            condition:
              conditions[Math.floor(Math.random() * conditions.length)],
            unit: "celsius"
          };
        }
      }),

      getUserTimezone: tool({
        description:
          "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
        inputSchema: z.object({})
      }),

      calculate: tool({
        description:
          "Perform a math calculation. Requires approval for large numbers (over 1000).",
        inputSchema: z.object({
          a: z.number().describe("First number"),
          b: z.number().describe("Second number"),
          operator: z.enum(["+", "-", "*", "/"]).describe("Arithmetic operator")
        }),
        needsApproval: async ({ a, b }) =>
          Math.abs(a) > 1000 || Math.abs(b) > 1000,
        execute: async ({ a, b, operator }) => {
          const ops: Record<string, (x: number, y: number) => number> = {
            "+": (x, y) => x + y,
            "-": (x, y) => x - y,
            "*": (x, y) => x * y,
            "/": (x, y) => x / y
          };
          if (operator === "/" && b === 0) {
            return { error: "Division by zero" };
          }
          return {
            expression: `${a} ${operator} ${b}`,
            result: ops[operator](a, b)
          };
        }
      })
    };
  }

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    // Splice the directory's shared MCP tools into this turn. Think
    // merges `config.tools` additively on top of the base tool set, so
    // whatever tools we return here join `workspace` / `extensions` /
    // `execute` / builtins on every turn. The proxy waits for any
    // in-progress MCP connections to settle (5s default) before
    // returning, so a chat that just woke up still sees tools from
    // servers that are mid-handshake.
    const mcpTools = await this.sharedMcp.getAITools();
    // Session system prompts are normally frozen for provider prefix caching.
    // The story block is deliberately live, so refresh it before every turn;
    // otherwise a chat could keep seeing an old HEAD/revision/dirty state.
    const system = await this.session.refreshSystemPrompt();

    console.log(
      `Turn starting: ${Object.keys(ctx.tools).length} base tools + ${Object.keys(mcpTools).length} MCP tools, continuation=${ctx.continuation}`
    );

    return { system, tools: mcpTools };
  }

  beforeToolCall(ctx: ToolCallContext): void {
    console.log(`Tool call: ${ctx.toolName} (${describeValueShape(ctx.input)})`);
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    if (ctx.success) {
      console.log(
        `Tool result: ${ctx.toolName} (${describeValueShape(ctx.output)}, ${ctx.durationMs}ms)`
      );
    } else {
      console.error(
        `Tool failed: ${ctx.toolName} (${ctx.durationMs}ms, ${describeErrorType(ctx.error)})`
      );
    }
  }

  onStepFinish(ctx: StepContext): void {
    if (ctx.usage) {
      console.log(
        `Step finished (${ctx.finishReason}): ${ctx.usage.inputTokens}in/${ctx.usage.outputTokens}out`
      );
    }
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    console.log(`Turn ${result.status}: ${result.message.parts.length} parts`);

    // Update the sidebar preview on the parent directory. Best-effort —
    // the chat should still function if the RPC fails.
    const preview = result.message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .slice(0, 120);
    if (!preview) return;

    try {
      const directory = await this.parentAgent(AssistantDirectory);
      await directory.recordChatTurn(this.name, preview);
    } catch (err) {
      console.warn("[MyAssistant] Failed to update directory preview:", err);
    }
  }

  // No `onStart` override: MCP is shared from the parent directory
  // (see `AssistantDirectory.onStart`), schedules live on the parent,
  // and everything per-chat (workspace, extensions, session config)
  // is wired up by Think's own base `onStart` via class fields.

  /**
   * Called by `AssistantDirectory.dailySummary()` on the daily cron.
   * Queues a proactive user message so the model produces a summary on
   * the next connection/turn. Runs as an RPC from the parent — no
   * model call happens here.
   *
   * Deliberately NOT `@callable()` — parent→child DO RPC doesn't need
   * the decorator, and exposing this to browsers would let a client
   * inject a "summarize recent work" prompt on demand.
   */
  async postDailySummaryPrompt() {
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: "Generate a brief summary of what we worked on recently. Check the workspace for any files and summarize the current state of things."
          }
        ]
      }
    ]);
  }

  // `addServer` / `removeServer` used to live here as `@callable`
  // wrappers around `this.addMcpServer` / `this.removeMcpServer`. They
  // moved to `AssistantDirectory` so every chat shares one MCP server
  // list. The client now calls the directory directly via `useChats()`;
  // see `src/use-chats.ts`.

  @callable()
  async getResponseVersions(userMessageId: string) {
    return this.session.getBranches(userMessageId);
  }

  @callable()
  updateConfig(config: AgentConfig) {
    this.configure<AgentConfig>(config);
  }

  @callable()
  currentConfig() {
    return this.getConfig<AgentConfig>();
  }

  @callable()
  async listWorkspaceFiles(path: string = "/") {
    try {
      return await this.workspace.readDir(path);
    } catch {
      return [];
    }
  }

  @callable()
  async readWorkspaceFile(path: string) {
    try {
      return await this.workspace.readFile(path);
    } catch {
      return null;
    }
  }

  @callable()
  async listExtensions() {
    if (!this.extensionManager) return [];
    return this.extensionManager.list();
  }
}

function describeValueShape(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value.length} chars`;
  if (Array.isArray(value)) return `array:${value.length} items`;
  if (value instanceof Uint8Array) return `bytes:${value.byteLength}`;
  if (typeof value === "object") {
    return `object:${Object.keys(value).length} fields`;
  }
  return typeof value;
}

function describeErrorType(value: unknown): string {
  return value instanceof Error ? value.name : typeof value;
}
