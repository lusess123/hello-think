# Assistant

A showcase of all Project Think features, built with `@cloudflare/think` and
the sub-agent routing primitive from `agents`.

## What this demonstrates

- **Multi-session via sub-agent routing** — each user gets an `AssistantDirectory`
  parent DO (a `Think` root used as an accumulator) that owns the sidebar. Each
  chat is its own `MyAssistant` facet (full Think DO — own extensions, memory,
  messages). Addressed transparently via
  `useAgent({ sub: [{ agent: "MyAssistant", name: chatId }] })`
- **Shared workspace across chats** — `AssistantDirectory` owns one `Workspace`
  backed by its SQLite; every `MyAssistant` child gets a `SharedWorkspace`
  proxy that forwards file I/O to the parent. A `hello.txt` written in chat A
  is visible verbatim in chat B. The proxy swaps in via the `WorkspaceFsLike`
  type exported by `@cloudflare/shell` — no casts; builtin workspace tools
  AND codemode's `state.*` sandbox API both route through it
- **Shared MCP across chats** — server registry, OAuth credentials, live
  connections, and tool descriptors all live on `AssistantDirectory`. Auth
  to a server once (e.g. GitHub MCP) and every chat sees its tools. Each
  child carries a `SharedMCPClient` proxy that builds per-turn MCP tool
  sets via one DO RPC hop to the parent. `useChats()` surfaces
  `mcpState` / `addMcpServer` / `removeMcpServer` so the MCP panel is
  the same across chats and open tabs
- **Live cross-chat file updates** — the directory's `Workspace` is wired
  with `onChange` → `broadcast`, so every open tab's file browser updates
  live whenever any chat writes, edits, or deletes a file. `useChats()`
  surfaces it as a `workspaceRevision` counter for `useEffect` deps
- **Think base class** — `getModel()`, `configureSession()`, `getTools()`, `maxSteps` for a batteries-included agent
- **Built-in workspace** — file tools (read, write, edit, find, grep, delete) auto-wired on every turn
- **Sandboxed code execution** — `createExecuteTool` lets the LLM write and run JavaScript in a Dynamic Worker via `@cloudflare/codemode`
- **Browser automation** — the `BROWSER` binding gives the execute sandbox a `cdp.*` connector: a real browser driven over the Chrome DevTools Protocol, with durable sessions the model can promote and reuse across messages
- **Stateless browsing (Quick Actions)** — `createQuickActionTools` adds `browser_markdown`, `browser_extract`, `browser_links`, and `browser_scrape` for one-shot page reads (no CDP session or sandbox); the model uses these for simple reads and `cdp.*` for interactive automation
- **HTTP fetch** — the `fetchTools` property registers a read-only `fetch_url` tool; this demo allows any public URL (`http(s)://**`, though private/loopback targets are always refused), and large/binary responses spill into the shared workspace (`spillToWorkspace`) so they show up in the file browser instead of bloating the transcript
- **Self-authored extensions** — `extensionLoader` + `createExtensionTools` let the agent create new tools at runtime
- **Persistent memory** — context blocks (`soul`, `memory`) the model can read and write across sessions
- **Non-destructive compaction** — older messages summarized when context overflows, originals preserved
- **Mid-turn overflow recovery** — `contextOverflow` + `classifyChatError` compact and re-run a turn that exceeds the context window mid-flight, instead of failing
- **Searchable knowledge base** — FTS5-backed `AgentSearchProvider` with `search_context` and `set_context` tools
- **Agent Skills** — a colocated `workspace-digest` skill (`agents:skills`) the model activates on demand, with a runnable TypeScript `run_skill_script` (`skills.runner`) that inspects the shared workspace via the Worker Loader
- **Dynamic configuration** — typed `AgentConfig` with model tier and persona, persisted in SQLite
- **Server-side tools** — `getWeather`, `calculate` execute on the server
- **Client-side tools** — `getUserTimezone` runs in the browser via `onToolCall`
- **Tool approval** — `calculate` requires user approval for large numbers
- **MCP integration** — connect external tool servers; tools appear in every chat automatically (shared at the directory level)
- **Lifecycle hooks** — `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChatResponse`
- **Durable chat recovery** — Think's default `chatRecovery` wraps turns in fibers for eviction recovery, with bounded retry/exhaustion behavior
- **Declarative scheduled work** — the directory is a `Think` accumulator that declares a daily-summary task via `getScheduledTasks()` (a deterministic handler), reconciled by Think on startup; it fans out to the most recently active chat
- **Regeneration with branch navigation** — v1/v2/v3 response versions via `getBranches`
- **Streaming markdown rendering** — assistant replies render through [streamdown](https://streamdown.ai) with syntax-highlighted code blocks (`@streamdown/code`)
- **Stream resumption** — page refresh replays the active stream (built into Think)
- **useAgentChat** — the Think React hook speaks the CF_AGENT chat protocol
- **GitHub OAuth** — users sign in with GitHub; the Worker owns all DO naming, so each user gets their own directory + isolated chats

## How to run

### 1. Configure GitHub App OAuth

Open the GitHub App's **General** settings, generate a client secret, and set:

- **Homepage URL:** the deployed application origin
- **Callback URL:** `<application-origin>/auth/callback`

GitHub Apps expose a Client ID and Client Secret for the user authorization
flow used by this application. Loopback development uses `DEV_USER=local`, so
it does not redirect through GitHub unless that escape hatch is removed.

### 2. Add your env vars

```sh
cp .env.example .env
```

Then fill in:

```sh
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
```

### 3. Start the example

```sh
npm install
npm start
```

Open the app, click **Sign in with GitHub**, approve the OAuth flow, and you
will land in the Think assistant scoped to your GitHub login.

> [!TIP]
> Loopback development (`localhost` / `127.0.0.1`) uses the tracked
> `DEV_USER=local` Wrangler var and skips OAuth. The server ignores this var on
> every deployed hostname, so production always uses a verified GitHub user.

To manually exercise client stream resumption, ask for a long response and
refresh the page mid-stream. To exercise Durable Object eviction recovery,
compare this app with `experimental/forever-chat`, which includes dedicated
provider-specific `onChatRecovery` examples and restart testing notes.

## Architecture

```
AssistantDirectory ("github-11750878")  ◄── one DO per immutable GitHub user ID
  ├─ MyAssistant[chat-abc]   [facet]    ◄── each chat is its own Think DO
  ├─ MyAssistant[chat-def]   [facet]
  └─ MyAssistant[chat-ghi]   [facet]
```

`AssistantDirectory` is a `Think` root used as an accumulator (its own
chat machinery stays dormant). It owns the chat list, the sidebar state,
the shared workspace, the shared MCP registry (servers, OAuth creds, live
connections), and cross-chat concerns like the daily-summary scheduled
task it declares via `getScheduledTasks()` and fans out to one chat.
`MyAssistant` is a Think DO per conversation, with its own
SQLite storage, extensions, and message history — plus a
`SharedWorkspace` proxy and a `SharedMCPClient` proxy that route file
operations and MCP tool invocations back to the directory.

The browser never chooses a DO name. It connects to `/chat` (the
directory) and `/chat/sub/my-assistant/<chatId>` (a specific chat), and
the Think generated Worker entry calls `src/server.ts`, where the app resolves
the `AssistantDirectory` instance from the authenticated GitHub cookie. The
production DO name uses the immutable numeric ID; the mutable login is only a
human-facing label:

```ts
if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
  const user = await getGitHubUserFromRequest(request);
  if (!user) return createUnauthorizedResponse(request);
  const directory = await getAgentByName(
    env.AssistantDirectory,
    `github-${user.id}`
  );
  await directory.registerAuthenticatedUser(user);
  return think.router.routeSubAgent(request, directory, {
    parent: "assistant"
  });
}
```

Think's router resolves the friendly `/sub/my-assistant/<chatId>` tail through
the generated manifest before handing off to the directory's built-in sub-agent
router. No per-chat plumbing or generated class URL segment knowledge lives in
the Worker. Access control lives on the parent via `onBeforeSubAgent` as a
strict registry gate:

```ts
override async onBeforeSubAgent(_req, { className, name }) {
  if (!this.hasSubAgent(className, name)) {
    return new Response("Not found", { status: 404 });
  }
}
```

On the client, `useChats()` (a local hook in `src/use-chats.ts`) wraps
the sidebar connection and RPCs. Each chat pane uses
`useAgent({ agent: "AssistantDirectory", basePath: "chat", sub: [{ agent: "MyAssistant", name: chatId }] })`.
See `examples/multi-ai-chat` for the minimal AIChatAgent version of the
same pattern.

### Shared workspace

Each `MyAssistant` overrides `this.workspace` with a `SharedWorkspace`
proxy that forwards every call to `AssistantDirectory.workspace` over
a DO RPC hop:

```ts
class MyAssistant extends Think<Env> {
  override workspace: WorkspaceFsLike = new SharedWorkspace(this);

  getTools() {
    return {
      // The agent one-liner: ctx/loader from the agent, and state.* in the
      // sandbox hits the shared workspace because SharedWorkspace satisfies
      // WorkspaceFsLike. tools.* adds the workspace tools (and any
      // needsApproval tools pause durably for the approval card).
      execute: createExecuteTool(this, {
        tools: createWorkspaceTools(this.workspace)
      })
      // ...
    };
  }
}

class SharedWorkspace implements WorkspaceFsLike {
  readFile(p) {
    return (await this.parent()).readFile(p);
  }
  writeFile(p, c) {
    return (await this.parent()).writeFile(p, c);
  }
  // ...readFileBytes / writeFileBytes / appendFile / exists / stat /
  //    lstat / mkdir / readDir / rm / cp / mv / symlink / readlink / glob
}
```

The proxy satisfies `@cloudflare/shell`'s `WorkspaceFsLike` interface,
which is a strict superset of `@cloudflare/think`'s `WorkspaceLike`.
That one type annotation unlocks two things at once:

- **All of Think's workspace-aware machinery** (`createWorkspaceTools`,
  lifecycle hooks, the builtin `listWorkspaceFiles` /
  `readWorkspaceFile` RPCs) works unchanged against the proxy.
- **Codemode's `state.*` sandbox API** works too, via
  `createWorkspaceStateBackend(this.workspace)`. Multi-file operations
  like `state.planEdits` and `state.applyEdits` run against the shared
  workspace, so a plan composed in one chat can mutate files another
  chat just created.

The parent DO and the child facet live on the same machine, so each
RPC hop is in-process and cheap (no network, no serialization across
external links).

**Trade-offs worth knowing:**

- _Every chat can see every chat's files._ That's the design — a
  multi-chat assistant should remember what it wrote in previous
  chats. If you fork this for a less-trusted surface (e.g. public
  guests), gate access in `AssistantDirectory` instead of exposing the
  workspace methods directly.
- _Extensions, messages, Think config, and branch history stay
  per-chat._ The workspace and the MCP registry are shared; everything
  else lives in each child DO's own storage. Extensions in particular
  persist to `ctx.storage` (not the workspace), so a tool authored in
  chat A isn't auto-available in chat B. That's a sensible default for
  this demo — extensions are "this chat's custom tools" — but if you
  want a fork where extensions cross chats too, move their persistence
  into the parent directory DO alongside the workspace and MCP
  registry.
- _Extensions with `workspace: "read-write"` permissions inherit the
  same reach._ The shell-level permission model is about what _the
  LLM_ can do inside a single chat; it doesn't distinguish between
  "this chat's files" and "this user's files" because the underlying
  `Workspace` doesn't either. For the assistant example this is what
  we actually want. For other apps — e.g. a hostile-code sandbox —
  consider giving each chat its own non-shared workspace by removing
  the override in `MyAssistant`.
- _Serialization is per-file, not per-turn._ Two chats writing to the
  same path queue behind each other in the parent DO's single-threaded
  isolate, which is the usual semantics you'd want.
- _Change events fan out to every client, but not to sibling chats._
  `AssistantDirectory.workspace` is constructed with `onChange: (ev)
=> this.broadcast(...)`, so every file mutation reaches every client
  connected to the directory — that's every browser tab the user has
  open, across every chat. `useChats()` translates those broadcasts
  into a `workspaceRevision` counter that chat panes pass into their
  file-browser effects, so a write in chat A lights up chat B's files
  list live. The parent does _not_ RPC events into sibling child
  facets — no server-side tool in this example reacts to another
  chat's writes. Add a parent → child RPC if that use case shows up.

### Shared MCP

MCP follows the same pattern as the workspace: the registry, OAuth
credentials, live connections, and tool caches all live on
`AssistantDirectory`. Each child carries a `SharedMCPClient` proxy
that RPCs the parent on each turn:

```ts
class MyAssistant extends Think<Env> {
  sharedMcp = new SharedMCPClient(this);

  async beforeTurn(ctx) {
    // Splice the directory's shared MCP tools into this turn.
    return { tools: await this.sharedMcp.getAITools() };
  }
}

class SharedMCPClient {
  async getAITools(timeoutMs = 5_000): Promise<ToolSet> {
    const parent = await this.parent();
    // Wait up to `timeoutMs` for any in-progress connections; returns
    // only tools from servers that are ready.
    const descriptors = await parent.listMcpToolDescriptors(timeoutMs);
    return buildToolSet(descriptors, (serverId, name, args) =>
      parent.callMcpTool(serverId, name, args)
    );
  }
}
```

OAuth callback URL is `/chat/mcp-callback` — one URL for every
server across every chat. The Worker's existing `/chat*` gate
forwards it to the directory; `Agent._onRequest` dispatches to
`handleMcpOAuthCallback`, which uses `mcp.isCallbackRequest` to
match on stored callback URLs. Token lives in the directory's DO
storage via `DurableObjectOAuthClientProvider`.

Browser-side, `useChats()` exposes `mcpState`, `addMcpServer`,
`removeMcpServer`, sourced from the directory's
`CF_AGENT_MCP_SERVERS` broadcasts. The MCP panel in each `Chat`
reads these from props, so every tab sees the same server list in
real time.

**Trade-offs worth knowing:**

- _Every chat can call every MCP tool you've connected._ Same model
  as the workspace — this is the point of a multi-chat assistant. If
  you need per-chat tool gating, filter in `SharedMCPClient.getAITools`
  using the existing `getAITools(filter?)` signature on
  `MCPClientManager` as a template.
- _Each tool invocation is one extra DO RPC hop._ Same machine,
  in-process, cheap. If an MCP tool call is network-bound (most are),
  the added hop is noise.
- _The parent's isolate is the serialization point._ Two chats
  calling tools at the same time interleave in the parent's JS event
  loop (single-threaded DO isolate). MCP tools usually await network,
  so they don't block each other in practice, but the parent is
  technically the user's MCP fan-in point.
- _Connection count per user = server count._ The directory keeps
  one live connection per registered server. SSE-style MCP transports
  are lightweight but still real. Worth knowing before forking this
  for users who register dozens of servers.
- _OAuth callbacks on this URL require an authenticated GitHub
  session._ Callbacks come back to the same origin in the user's
  browser, so the GitHub session cookie is present; the Worker's
  existing `/chat*` gate validates it before forwarding to the
  directory. Unauthenticated probes to `/chat/mcp-callback` 401.

## 剧本工作台

剧本数据使用 GitHub 和 Durable Object 两层存储：

```text
GitHub main                         正式版本
GitHub drafts/github-<github-id>    已确认的个人草稿提交
AssistantDirectory SQLite           尚未确认的云端工作区
```

主编辑入口是一张统一设计画板：人物关系图和剧情流程图同屏展示，剧情以
`opening` 为根按自上而下的树形 DAG 排布，`next`、`routes`、`parallel`、
`waitFor`、`end` 都按拓扑可视化；点击
人物、关系、剧情节点或边，使用应用内 Dialog 编辑。业务 Diff 直接叠加
到对应节点和连线上，JSON 只作为辅助编辑视图。所有修改与 Agent 修改
共享同一个 Durable Object 工作区，只有用户在界面检查设计 Diff 并二次
确认后，服务端才会使用 GitHub Git Data API 非 force 更新个人草稿分支。
Git commit 和每次工作区 revision 都可恢复，恢复本身仍是新的未提交留痕。
画板右下角小地图支持点击跳转和拖拽视口，滚轮以指针位置为锚点缩放，并与
`+`、`−`、适应画布和百分比控件保持同步。

当前数据仓库与默认文件：

```text
https://github.com/lusess123/dsl-data
stories/default/story.json
```

本地验证固定使用 `drafts/local`；首次生产登录会新建独立的
`drafts/github-<github-id>`，不会自动继承本地测试分支或本地 PR。

本地开发会由 `scripts/start-local.mjs` 读取下面的 GitHub App 私钥，
不会把 PEM 复制到 dotenv 或 Git 历史：

```text
.ai-doc/gihtub/dsl-chat.2026-07-18.private-key.pem
```

如私钥位于其他位置：

```sh
STORY_GITHUB_PRIVATE_KEY_PATH=/absolute/path/to/key.pem npm start
```

当前 Cloudflare Vite 插件需要 Node.js 24；先确认 `node --version`，再运行
`npm start`。生产环境应将 `STORY_GITHUB_PRIVATE_KEY` 配置为 Worker Secret，
公开的 App、Installation 和仓库标识保留在 `wrangler.jsonc` 的 vars 中。

## Deploying

Update the GitHub App so its callback URL points at production:

```text
https://your-domain.example/auth/callback
```

Configure these GitHub Actions repository secrets (local dotenv values are
never bundled):

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
APP_GITHUB_CLIENT_ID
APP_GITHUB_CLIENT_SECRET
AI_GATEWAY_BASE_URL
AI_GATEWAY_TOKEN
STORY_GITHUB_PRIVATE_KEY
```

`STORY_ALLOWED_GITHUB_USERS` in `wrangler.jsonc` is a comma-separated list of
immutable numeric GitHub user IDs. Add every editor there; login names are
intentionally rejected because they can be renamed and reused.

Deploy by manually running the **Deploy Cloudflare Worker** GitHub Actions
workflow. The workflow runs tests and the production build before `wrangler
deploy`; do not deploy from a developer machine.

## Key code

**Server** (`src/server.ts`):

```typescript
export class AssistantDirectory extends Think<Env, DirectoryState> {
  // Strict registry gate — clients can only reach chats this
  // directory spawned via `createChat`.
  override async onBeforeSubAgent(_req, { className, name }) {
    if (!this.hasSubAgent(className, name)) {
      return new Response("Not found", { status: 404 });
    }
  }

  @callable()
  async createChat() {
    const id = nanoid(10);
    await this.subAgent(MyAssistant, id); // spawn the facet
    /* ... persist meta, refresh sidebar ... */
  }

  // Cross-chat scheduled work, declared (not hand-wired) and reconciled
  // by Think on startup.
  override getScheduledTasks() {
    return {
      dailySummary: {
        schedule: "every day at 09:00",
        handler: async () => {
          /* RPC a summary prompt into the most-recent chat */
        }
      }
    };
  }
}

export class MyAssistant extends Think<Env> {
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  getModel() {
    /* model tier from config */
  }
  configureSession(session) {
    /* persona, memory, compaction, knowledge */
  }
  getTools() {
    /* execute, extensions, quick-action browser tools, getWeather, calculate, ... */
  }

  // Each turn updates the parent's sidebar preview via the
  // typed `parentAgent(AssistantDirectory)` stub.
  async onChatResponse(result) {
    const directory = await this.parentAgent(AssistantDirectory);
    await directory.recordChatTurn(this.name, extractPreview(result));
  }
}
```

**Client** (`src/client.tsx`) — `useChats()` (a local prototype in
`src/use-chats.ts`) drives the sidebar; each chat pane uses
`useAgentChat` from `@cloudflare/think/react` over a sub-routed
`useAgent` connection.

## Related

- [Think docs](../../docs/think/index.md)
- [Think tools](../../docs/think/tools.md)
- [Think lifecycle hooks](../../docs/think/lifecycle-hooks.md)
