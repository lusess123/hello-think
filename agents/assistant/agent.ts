import { callable } from "agents";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Think, Workspace } from "@cloudflare/think";
import type { ThinkScheduledTasks } from "@cloudflare/think";
import type { FileInfo, WorkspaceChangeEvent } from "@cloudflare/shell";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import { MyAssistant } from "./agents/my-assistant/agent";
import { createGatewayModel } from "./gateway-model";
import { DocumentLibrary } from "./document-library";
import type {
  DocumentRecord,
  SearchDocumentsOptions,
  SearchDocumentsResult
} from "./document-library";
import { isTextDocument, parseDocumentBytes } from "./document-parser";
import {
  GitHubApiError,
  GitHubAppClient,
  GitHubConflictError,
  MysteryStoryDslSchema,
  StoryCommitInProgressError,
  StoryWorkspaceConflictError,
  StoryWorkspaceRebaseConflictError,
  StoryWorkspaceStore,
  githubAppConfigFromEnv,
  type MysteryStoryDsl,
  type StoryWorkspace,
  type StoryWorkspaceDiff
} from "./story";
import type { ChatSummary, DirectoryState, McpToolDescriptor } from "./types";

const MAX_DOCUMENT_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PDF_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_INDEX_BYTES = 32 * 1024 * 1024;

// ── AssistantDirectory — one DO per authenticated GitHub user ─────────
//
// Owns:
//   - the chat index (titles, timestamps, previews) in `chat_meta`
//   - access control for its child chats (strict-registry gate)
//   - cross-chat scheduled work (daily summary)
//
// **Existence is framework-owned.** The authoritative set of chats is
// `listSubAgents(MyAssistant)` — the registry `subAgent()` /
// `deleteSubAgent()` maintain in lockstep with the actual facets. We
// keep a separate `chat_meta` table for metadata (title, preview) keyed
// by chat id; a row there is pure decoration. If they drift, the
// registry wins.

export class AssistantDirectory extends Think<Env, DirectoryState> {
  initialState: DirectoryState = { chats: [] };

  // The directory is a Think root used as an accumulator: it owns the
  // chat index, shared workspace, MCP registry, and cross-chat
  // scheduled work, but its own chat machinery stays dormant (clients
  // talk to per-chat `MyAssistant` facets, not the directory). Declaring
  // it as `Think` lets the directory own a declarative scheduled task
  // (see `getScheduledTasks`) and leaves room for top-level agentic work
  // later. `getModel()` is a stub for that future use — nothing in the
  // accumulator role calls it.
  override getModel() {
    return createGatewayModel(this.env);
  }

  /**
   * Shared workspace for every chat under this directory. Backed by the
   * directory's own SQLite so all of a user's files live in one place —
   * a `hello.txt` written in chat A shows up verbatim in chat B.
   *
   * Children (`MyAssistant` facets) see this workspace through the
   * `SharedWorkspace` proxy below, which forwards each call to
   * `readFile` / `writeFile` / etc. here. See `SharedWorkspace`.
   *
   * The `onChange` hook fires on every mutation (create/update/delete)
   * regardless of which chat's tool caused it. We rebroadcast to every
   * client connected to this directory — that's every browser tab the
   * user has open — so live UI like the file browser refreshes across
   * chats and tabs without polling. See `_broadcastWorkspaceChange`.
   *
   * Security note: this means any tool running inside any chat has
   * read-write access to every file this user owns. That's the point —
   * a multi-chat assistant should remember what it did in previous
   * chats — but extensions declared with `workspace: "read-write"`
   * inherit the same reach. If you fork this example for a
   * less-trusted extension surface, add gating here.
   */
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name,
    onChange: (event) => this._broadcastWorkspaceChange(event),
    r2: this.env.R2
  });

  /** Original bytes stay in R2; only metadata and searchable chunks use SQL. */
  documentLibrary = new DocumentLibrary(this.ctx.storage.sql);

  /** Lazily created so non-story tests do not require GitHub App secrets. */
  private storyStore?: StoryWorkspaceStore;

  private getStoryStore(): StoryWorkspaceStore {
    this.storyStore ??= new StoryWorkspaceStore(
      this.ctx.storage,
      new GitHubAppClient(githubAppConfigFromEnv(this.env))
    );
    return this.storyStore;
  }

  private get storyPath(): string {
    return this.env.STORY_GITHUB_PATH?.trim() || "stories/default/story.json";
  }

  /**
   * The Durable Object and draft branch are keyed by immutable GitHub user ID.
   * Keep the login separately for human-facing actor labels.
   */
  async registerAuthenticatedUser(input: { id: number; login: string }): Promise<void> {
    const id = Number(input.id);
    const login = input.login?.trim();
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !login ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)
    ) {
      throw new Error("无效的 GitHub 用户身份");
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS authenticated_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        github_id INTEGER NOT NULL,
        login TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const existing = this.ctx.storage.sql
      .exec<{ github_id: number }>(
        "SELECT github_id FROM authenticated_identity WHERE singleton = 1"
      )
      .toArray()[0];
    if (existing && existing.github_id !== id) {
      throw new Error("Durable Object 已绑定到另一个 GitHub 用户");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO authenticated_identity (singleton, github_id, login, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         github_id = excluded.github_id,
         login = excluded.login,
         updated_at = excluded.updated_at`,
      id,
      login,
      Date.now()
    );
  }

  private get storyOwnerIdentity(): { id: number; login: string } {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS authenticated_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        github_id INTEGER NOT NULL,
        login TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const row = this.ctx.storage.sql
      .exec<{ github_id: number; login: string }>(
        "SELECT github_id, login FROM authenticated_identity WHERE singleton = 1"
      )
      .toArray()[0];
    return row
      ? { id: row.github_id, login: row.login }
      : { id: 0, login: this.name };
  }

  private get storyOwnerLogin(): string {
    return this.storyOwnerIdentity.login;
  }

  private get storyBranch(): string {
    // `this.name` is `github-<immutable id>` in production and the familiar
    // login (`local`) only on loopback, preserving the existing local branch.
    return storyBranchName(this.name);
  }

  /**
   * Fan-out: push workspace change events to every client connected to
   * this directory. Each chat pane's `useAgent` connection to the
   * directory (via `useChats()`) receives these; the client side
   * treats them as signals to refresh workspace-backed UI.
   *
   * Deliberately a best-effort `broadcast` (not `setState`), so file
   * churn doesn't trigger full `DirectoryState` re-broadcasts on every
   * write. Does NOT notify sibling child facets — no tool in this
   * example reacts server-side to another chat's writes. Add a
   * parent → child RPC here if that use case shows up.
   */
  private _broadcastWorkspaceChange(event: WorkspaceChangeEvent): void {
    this.broadcast(JSON.stringify({ type: "workspace-change", event }));
  }

  private _broadcastDocumentChange(document: DocumentRecord): void {
    this.broadcast(JSON.stringify({ type: "document-change", document }));
  }

  private _broadcastStoryChange(workspace: StoryWorkspace): void {
    this.broadcast(
      JSON.stringify({
        type: "story-change",
        branch: workspace.branch,
        revision: workspace.revision,
        dirty: workspace.dirty,
        baseCommitSha: workspace.baseCommitSha,
        restoredFromSha: workspace.restoredFromSha,
        restoredFromEventId: workspace.restoredFromEventId,
        remoteHeadSha: workspace.remoteHeadSha
      })
    );
  }

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS chat_meta (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT
    )`;
    this._refreshState();

    // Cross-chat scheduled work is declared in `getScheduledTasks()` below
    // and reconciled automatically by Think after this `onStart` runs — no
    // manual `schedule()` call needed. (Sub-agents and Think roots alike can
    // own declarative scheduled tasks; the directory owns this one because
    // the daily summary is a cross-chat concern.)

    // OAuth popup handler for MCP servers. The directory owns the MCP
    // state, so the OAuth redirect (`/chat/mcp-callback`) lands here
    // and the framework dispatches into `this.mcp` via
    // `handleMcpOAuthCallback` on the base `Agent` class.
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  /**
   * Authenticated document HTTP API. `src/server.ts` resolves the current user
   * before forwarding `/chat/documents*` to this exact directory instance.
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (/\/story(?:\/|$)/.test(url.pathname)) {
      return this._handleStoryRequest(request, url);
    }
    const documentPath = /\/documents(?:\/([^/]+))?(?:\/(content|retry))?\/?$/.exec(
      url.pathname
    );
    if (!documentPath) return new Response("Not found", { status: 404 });

    const documentId = documentPath[1]
      ? decodeURIComponent(documentPath[1])
      : null;
    const action = documentPath[2] ?? null;

    if (request.method === "GET" && documentId === "search" && !action) {
      const query = url.searchParams.get("q") ?? "";
      const documentIds = url.searchParams.getAll("documentId");
      return documentJson(
        this.documentLibrary.searchDocuments(query, {
          documentIds,
          limit: numericQuery(url, "limit", 12),
          maxTokens: numericQuery(url, "maxTokens", 8_000)
        })
      );
    }

    if (request.method === "GET" && !documentId) {
      return documentJson({
        documents: this.documentLibrary.listDocuments({
          limit: numericQuery(url, "limit", 200),
          offset: numericQuery(url, "offset", 0)
        })
      });
    }

    if (request.method === "POST" && !documentId) {
      return this._uploadDocument(request);
    }

    if (!documentId) return new Response("Not found", { status: 404 });
    const document = this.documentLibrary.getDocument(documentId);
    if (!document) return documentJson({ error: "文档不存在" }, { status: 404 });

    if (request.method === "GET" && action === "content") {
      if (!document.storagePath) {
        return documentJson({ error: "文档没有原始文件" }, { status: 404 });
      }
      const object = await this.env.R2.get(document.storagePath);
      if (!object) return documentJson({ error: "原始文件不存在" }, { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      const contentType = safeDocumentContentType(document.mimeType);
      const disposition = canDisplayDocumentInline(contentType)
        ? "inline"
        : "attachment";
      headers.set("Cache-Control", "private, max-age=60");
      headers.set(
        "Content-Disposition",
        `${disposition}; filename*=UTF-8''${encodeURIComponent(document.name)}`
      );
      headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
      headers.set("Content-Type", contentType);
      headers.set("ETag", object.httpEtag);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(object.body, { headers });
    }

    if (request.method === "POST" && action === "retry") {
      if (document.status !== "failed") {
        return documentJson(
          { error: "只有失败的文档可以重试，当前任务仍在处理或已经完成" },
          { status: 409 }
        );
      }
      let pending = this.documentLibrary.markDocument(documentId, "pending");
      this._broadcastDocumentChange(pending);
      try {
        await this._startDocumentIngest(documentId);
      } catch {
        // Starting a Workflow can fail before an instance is created. The
        // original remains in R2 and `_startDocumentIngest` records the
        // failure, so return the current row and keep Retry useful.
        pending = this.documentLibrary.getDocument(documentId) ?? pending;
      }
      return documentJson({ document: pending }, { status: 202 });
    }

    if (request.method === "DELETE" && !action) {
      if (document.storagePath) await this.env.R2.delete(document.storagePath);
      this.documentLibrary.deleteDocument(documentId);
      this.broadcast(
        JSON.stringify({ type: "document-delete", documentId })
      );
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && !action) {
      return documentJson({ document });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  /**
   * Authenticated story working-tree API. The Worker has already resolved the
   * GitHub user to this directory, so request bodies can never select another
   * user's draft branch or Durable Object.
   */
  private async _handleStoryRequest(
    request: Request,
    url: URL
  ): Promise<Response> {
    const suffix = /\/story(?:\/(.*?))?\/?$/.exec(url.pathname)?.[1] ?? "";

    try {
      const workspace = await this.ensureStoryWorkspace();

      if (request.method === "GET" && suffix === "") {
        return documentJson({ workspace: this.storyWorkspaceView(workspace) });
      }

      if (request.method === "PUT" && suffix === "") {
        const body = await storyRequestJson(request);
        const expectedRevision = storyExpectedRevision(body);
        const source = storyUiSource(body.source);
        const story = MysteryStoryDslSchema.parse(body.story);
        const updated = this.getStoryStore().update({
          path: this.storyPath,
          expectedRevision,
          story,
          actor: `user:${this.storyOwnerLogin}`,
          source,
          summary: storyOptionalText(body.summary, "summary", 500)
        });
        this._broadcastStoryChange(updated);
        return documentJson({ workspace: this.storyWorkspaceView(updated) });
      }

      if (request.method === "POST" && suffix === "discard") {
        const body = await storyRequestJson(request);
        const updated = this.getStoryStore().discard({
          path: this.storyPath,
          expectedRevision: storyExpectedRevision(body),
          actor: `user:${this.storyOwnerLogin}`,
          source: "ui-discard"
        });
        this._broadcastStoryChange(updated);
        return documentJson({ workspace: this.storyWorkspaceView(updated) });
      }

      if (request.method === "POST" && suffix === "restore") {
        const body = await storyRequestJson(request);
        const updated = await this.getStoryStore().restoreToWorkspace({
          path: this.storyPath,
          sha: storyText(body.sha, "sha"),
          expectedRevision: storyExpectedRevision(body),
          actor: `user:${this.storyOwnerLogin}`,
          source: "ui-history-restore"
        });
        this._broadcastStoryChange(updated);
        return documentJson({ workspace: this.storyWorkspaceView(updated) });
      }

      if (request.method === "POST" && suffix === "restore-event") {
        const body = await storyRequestJson(request);
        const eventId = Number(body.eventId);
        if (!Number.isInteger(eventId) || eventId <= 0) {
          throw new Error("eventId 必须是正整数");
        }
        const updated = this.getStoryStore().restoreEventSnapshot({
          path: this.storyPath,
          eventId,
          expectedRevision: storyExpectedRevision(body),
          actor: `user:${this.storyOwnerLogin}`,
          source: "ui-event-restore"
        });
        this._broadcastStoryChange(updated);
        return documentJson({ workspace: this.storyWorkspaceView(updated) });
      }

      if (request.method === "POST" && suffix === "sync") {
        const body = await storyRequestJson(request);
        const updated = await this.getStoryStore().syncFromRemote({
          path: this.storyPath,
          expectedRevision: storyExpectedRevision(body),
          actor: `user:${this.storyOwnerLogin}`,
          source: "ui-remote-sync"
        });
        this._broadcastStoryChange(updated);
        return documentJson({ workspace: this.storyWorkspaceView(updated) });
      }

      if (request.method === "POST" && suffix === "commit") {
        const body = await storyRequestJson(request);
        const result = await this.getStoryStore().confirmCommit({
          path: this.storyPath,
          expectedRevision: storyExpectedRevision(body),
          message: storyText(body.message, "message"),
          actor: `user:${this.storyOwnerLogin}`,
          source: "ui-confirmation"
        });
        this._broadcastStoryChange(result.workspace);
        return documentJson({
          workspace: this.storyWorkspaceView(result.workspace),
          commit: result.commit
            ? {
                sha: result.commit.sha,
                message: result.commit.message,
                url: result.commit.htmlUrl
              }
            : null
        });
      }

      if (request.method === "GET" && suffix === "history") {
        const limit = Math.min(100, Math.max(1, numericQuery(url, "limit", 60)));
        const page = Math.max(1, numericQuery(url, "cursor", 1));
        const versions = await this.getStoryStore().listVersions(this.storyPath, {
          page,
          perPage: limit
        });
        return documentJson({
          versions: versions.map((version) => ({
            sha: version.sha,
            shortSha: version.sha.slice(0, 7),
            message: version.message,
            author: version.authorLogin ?? version.authorName ?? "GitHub App",
            committedAt: version.authoredAt,
            url: version.htmlUrl
          })),
          nextCursor: versions.length === limit ? String(page + 1) : undefined
        });
      }

      if (request.method === "GET" && suffix.startsWith("version/")) {
        const sha = decodeURIComponent(suffix.slice("version/".length));
        const version = await this.getStoryStore().getVersion(this.storyPath, sha);
        return documentJson({
          version: {
            sha: version.sha,
            shortSha: version.sha.slice(0, 7),
            message: version.message,
            author: version.authorLogin ?? version.authorName ?? "GitHub App",
            committedAt: version.authoredAt,
            url: version.htmlUrl
          },
          story: version.story
        });
      }

      if (request.method === "GET" && suffix === "events") {
        return documentJson({
          events: this.getStoryStore().listEvents(
            this.storyPath,
            numericQuery(url, "limit", 100)
          )
        });
      }

      if (request.method === "POST" && suffix === "pull-request") {
        const body = await storyRequestJson(request);
        const pullRequest = await this.getStoryStore().createPullRequest({
          path: this.storyPath,
          title: storyText(body.title, "title"),
          body: typeof body.body === "string" ? body.body : undefined,
          base: this.env.STORY_GITHUB_DEFAULT_BRANCH || "main"
        });
        return documentJson({ pullRequest });
      }

      return new Response("Method not allowed", { status: 405 });
    } catch (error) {
      return this.storyErrorResponse(error);
    }
  }

  private async _uploadDocument(request: Request): Promise<Response> {
    if (!request.body) {
      return documentJson({ error: "缺少文件内容" }, { status: 400 });
    }

    const declaredSize = Number(request.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_DOCUMENT_UPLOAD_BYTES) {
      return documentJson(
        { error: "单文件上传上限为 100 MB；更大文件请使用 R2 multipart" },
        { status: 413 }
      );
    }

    const rawName = request.headers.get("x-file-name") ?? "attachment";
    const name =
      decodeHeader(rawName)
        .replace(/[\u0000-\u001f\u007f]/gu, "")
        .trim()
        .slice(0, 255) || "attachment";
    const mimeType =
      request.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
      "application/octet-stream";
    const id = crypto.randomUUID();
    const storagePath = `documents/${encodeURIComponent(this.name)}/${id}/original`;

    const object = await this.env.R2.put(storagePath, request.body, {
      httpMetadata: { contentType: mimeType },
      // Keep R2 custom metadata ASCII-only. The original Unicode filename is
      // stored in SQLite and emitted through Content-Disposition on download.
      customMetadata: { documentId: id }
    });
    if (!object) {
      return documentJson({ error: "R2 上传失败" }, { status: 500 });
    }
    if (object.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      await this.env.R2.delete(storagePath);
      return documentJson(
        { error: "单文件上传上限为 100 MB；更大文件请使用 R2 multipart" },
        { status: 413 }
      );
    }

    let document: DocumentRecord;
    try {
      document = this.documentLibrary.createDocument({
        id,
        name,
        mimeType,
        storagePath,
        sizeBytes: object.size
      });
    } catch (error) {
      // No metadata row exists, so this object would otherwise be orphaned.
      await this.env.R2.delete(storagePath);
      throw error;
    }

    this._broadcastDocumentChange(document);
    try {
      await this._startDocumentIngest(id);
    } catch {
      // Upload succeeded even if Workflow creation did not. Preserve the
      // original and return the failed row so the UI can expose Retry.
      document = this.documentLibrary.getDocument(id) ?? document;
    }

    return documentJson(
      {
        document,
        contentUrl: `/chat/documents/${encodeURIComponent(id)}/content`
      },
      { status: 202 }
    );
  }

  private async _startDocumentIngest(documentId: string): Promise<void> {
    try {
      await this.runWorkflow(
        "DOCUMENT_INGEST_WORKFLOW",
        { documentId },
        {
          // Think generates the runtime class name (`ThinkAgent_Assistant`),
          // which the Agents SDK cannot map back to our Wrangler binding.
          // Workflow callbacks must resolve the root Agent by this binding.
          agentBinding: "AssistantDirectory",
          metadata: { documentId }
        }
      );
    } catch (error) {
      const failed = this.documentLibrary.markFailed(documentId, error);
      this._broadcastDocumentChange(failed);
      throw error;
    }
  }

  /** Called by DocumentIngestWorkflow over Agent RPC. */
  async processStoredDocument(documentId: string): Promise<number> {
    const document = this.documentLibrary.getDocument(documentId);
    if (!document) throw new Error(`文档不存在：${documentId}`);
    if (!document.storagePath) throw new Error("文档没有 R2 存储路径");
    const processing = this.documentLibrary.markProcessing(documentId);
    this._broadcastDocumentChange(processing);
    try {
      const parseByteLimit = documentParseByteLimit(
        document.mimeType,
        document.name
      );
      if (
        parseByteLimit !== null &&
        document.sizeBytes !== null &&
        document.sizeBytes > parseByteLimit
      ) {
        throw new Error(
          `原件已保存到 R2，但当前单次解析上限为 ${formatMegabytes(parseByteLimit)} MB；` +
            "请拆分文件或接入外部解析/OCR 流水线"
        );
      }
      const object = await this.env.R2.get(document.storagePath);
      if (!object) throw new Error("R2 原始文件不存在");
      const bytes =
        parseByteLimit === null
          ? new Uint8Array()
          : new Uint8Array(await object.arrayBuffer());
      const parsed = await parseDocumentBytes(
        bytes,
        document.mimeType,
        document.name
      );
      const ready = this.documentLibrary.processDocument(
        documentId,
        parsed.text
      );
      this._broadcastDocumentChange(ready);
      return ready.chunkCount;
    } catch (error) {
      // `step.do` owns retry policy. Keep the visible state processing between
      // attempts; the Workflow marks it failed only after retries are exhausted.
      const processing = this.documentLibrary.markProcessing(documentId);
      this._broadcastDocumentChange(processing);
      throw error;
    }
  }

  /** Called after the durable workflow exhausts retries. */
  async failDocumentIngest(
    documentId: string,
    message: string
  ): Promise<void> {
    if (!this.documentLibrary.getDocument(documentId)) return;
    const failed = this.documentLibrary.markFailed(documentId, message);
    this._broadcastDocumentChange(failed);
  }

  /** Child agents use this narrow RPC instead of reading the original file. */
  async searchDocuments(
    query: string,
    options: SearchDocumentsOptions = {}
  ): Promise<SearchDocumentsResult> {
    return this.documentLibrary.searchDocuments(query, options);
  }

  private async ensureStoryWorkspace(): Promise<StoryWorkspace> {
    return this.getStoryStore().initialize({
      path: this.storyPath,
      branch: this.storyBranch,
      fromBranch: this.env.STORY_GITHUB_DEFAULT_BRANCH || "main",
      initialStory: emptyStory(),
      actor: `system:${this.storyOwnerLogin}`,
      source: "initialize"
    });
  }

  /** Lightweight dynamic context injected into every model turn. */
  async getStoryState() {
    const workspace = await this.ensureStoryWorkspace();
    return {
      repository: `${this.env.STORY_GITHUB_OWNER}/${this.env.STORY_GITHUB_REPO}`,
      storyPath: workspace.path,
      mainBranch: this.env.STORY_GITHUB_DEFAULT_BRANCH || "main",
      branch: workspace.branch,
      head: workspace.baseCommitSha,
      revision: workspace.revision,
      dirty: workspace.dirty,
      restoredFromSha: workspace.restoredFromSha,
      restoredFromEventId: workspace.restoredFromEventId,
      remoteHeadSha: workspace.remoteHeadSha,
      modifiedBy: workspace.modifiedBy,
      modifiedAt: new Date(workspace.updatedAt).toISOString()
    };
  }

  /** Full shared working copy used by both the UI and child chat agents. */
  async getStoryWorkspace() {
    return this.storyWorkspaceView(await this.ensureStoryWorkspace());
  }

  async getStoryDiff() {
    const workspace = await this.ensureStoryWorkspace();
    return this.storyDiffView(this.getStoryStore().getDiff(workspace.path));
  }

  /** Compact Git + working-copy history for the model's version vocabulary. */
  async getStoryHistory(limit = 50) {
    const workspace = await this.ensureStoryWorkspace();
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const [versions, events] = await Promise.all([
      this.getStoryStore().listVersions(workspace.path, {
        page: 1,
        perPage: boundedLimit
      }),
      Promise.resolve(this.getStoryStore().listEvents(workspace.path, boundedLimit))
    ]);
    return {
      current: {
        branch: workspace.branch,
        head: workspace.baseCommitSha,
        revision: workspace.revision,
        dirty: workspace.dirty,
        restoredFromSha: workspace.restoredFromSha,
        restoredFromEventId: workspace.restoredFromEventId
      },
      commits: versions.map((version) => ({
        sha: version.sha,
        shortSha: version.sha.slice(0, 7),
        message: version.message,
        authoredAt: version.authoredAt,
        author: version.authorLogin ?? version.authorName ?? "GitHub App"
      })),
      revisions: events.map((event) => ({
        id: event.id,
        revision: event.revision,
        kind: event.kind,
        summary: event.summary,
        actor: event.actor,
        source: event.source,
        createdAt: new Date(event.createdAt).toISOString(),
        baseCommitSha: event.baseCommitSha,
        restoredFromSha: event.restoredFromSha,
        hasSnapshot: event.afterStory !== null,
        diffSummary: event.diff.business.summary
      }))
    };
  }

  async updateStoryWorkspace(input: {
    story: unknown;
    expectedRevision: number;
    actor: string;
    source: string;
    summary?: string;
  }) {
    await this.ensureStoryWorkspace();
    const updated = this.getStoryStore().update({
      path: this.storyPath,
      expectedRevision: input.expectedRevision,
      story: MysteryStoryDslSchema.parse(input.story),
      actor: input.actor,
      source: input.source,
      summary: input.summary
    });
    this._broadcastStoryChange(updated);
    return this.storyWorkspaceView(updated);
  }

  async restoreStoryVersionToWorkspace(sha: string, actor: string) {
    const current = await this.ensureStoryWorkspace();
    const updated = await this.getStoryStore().restoreToWorkspace({
      path: this.storyPath,
      sha,
      expectedRevision: current.revision,
      actor,
      source: "agent-history-restore"
    });
    this._broadcastStoryChange(updated);
    return this.storyWorkspaceView(updated);
  }

  async restoreStoryEventToWorkspace(
    eventId: number,
    expectedRevision: number,
    actor: string
  ) {
    await this.ensureStoryWorkspace();
    const updated = this.getStoryStore().restoreEventSnapshot({
      path: this.storyPath,
      eventId,
      expectedRevision,
      actor,
      source: "agent-event-restore"
    });
    this._broadcastStoryChange(updated);
    return this.storyWorkspaceView(updated);
  }

  private storyWorkspaceView(workspace: StoryWorkspace) {
    return {
      repository: `${this.env.STORY_GITHUB_OWNER}/${this.env.STORY_GITHUB_REPO}`,
      storyPath: workspace.path,
      path: workspace.path,
      mainBranch: this.env.STORY_GITHUB_DEFAULT_BRANCH || "main",
      branch: workspace.branch,
      baseCommitSha: workspace.baseCommitSha,
      restoredFromSha: workspace.restoredFromSha,
      restoredFromEventId: workspace.restoredFromEventId,
      remoteHeadSha: workspace.remoteHeadSha,
      revision: workspace.revision,
      dirty: workspace.dirty,
      story: workspace.workingStory,
      baseStory: workspace.baseStory,
      diff: this.storyDiffView(this.getStoryStore().getDiff(workspace.path)),
      modifiedBy: workspace.modifiedBy,
      modifiedAt: new Date(workspace.updatedAt).toISOString(),
      source: workspace.source
    };
  }

  private storyDiffView(diff: StoryWorkspaceDiff) {
    const items = (
      ["story", "cast", "bonds", "timeline"] as const
    ).flatMap((category) =>
      diff.business[category].map((change) => ({
        id: `${category}:${change.key}:${change.kind}`,
        action: change.kind,
        type: change.kind,
        category,
        scope: category,
        label: change.key,
        summary: storyChangeSummary(category, change.kind, change.key),
        path: `/${category}/${change.key}`,
        before: change.before,
        after: change.after,
        changedFields: change.changedFields
      }))
    );
    return {
      fileStatus: diff.fileStatus,
      summary: diff.business.summary,
      business: diff.business,
      items,
      json: diff.json,
      jsonLines: diff.json.map((line) => ({
        type: line.kind,
        action: line.kind,
        content: line.value,
        line: line.value,
        oldLine: line.oldLine ?? null,
        newLine: line.newLine ?? null
      }))
    };
  }

  private storyErrorResponse(error: unknown): Response {
    if (error instanceof StoryWorkspaceConflictError) {
      let currentWorkspace: unknown;
      try {
        currentWorkspace = this.storyWorkspaceView(
          this.getStoryStore().read(this.storyPath)
        );
      } catch {
        currentWorkspace = undefined;
      }
      return documentJson(
        { error: error.message, code: error.code, currentWorkspace },
        { status: 409 }
      );
    }
    if (
      error instanceof StoryCommitInProgressError
    ) {
      return documentJson(
        { error: error.message, code: error.code },
        { status: 409 }
      );
    }
    if (error instanceof GitHubConflictError) {
      let currentWorkspace: unknown;
      try {
        currentWorkspace = this.storyWorkspaceView(
          this.getStoryStore().read(this.storyPath)
        );
      } catch {
        currentWorkspace = undefined;
      }
      return documentJson(
        {
          error: error.message,
          code: error.code,
          expectedSha: error.expectedSha,
          actualSha: error.actualSha,
          currentWorkspace
        },
        { status: 409 }
      );
    }
    if (error instanceof StoryWorkspaceRebaseConflictError) {
      let currentWorkspace: unknown;
      try {
        currentWorkspace = this.storyWorkspaceView(
          this.getStoryStore().read(this.storyPath)
        );
      } catch {
        currentWorkspace = undefined;
      }
      return documentJson(
        {
          error: error.message,
          code: error.code,
          previousBaseSha: error.previousBaseSha,
          remoteHeadSha: error.remoteHeadSha,
          paths: error.paths,
          currentWorkspace
        },
        { status: 409 }
      );
    }
    if (error instanceof ZodError) {
      return documentJson(
        {
          error: "剧本不符合 DSL 结构",
          code: "STORY_VALIDATION_ERROR",
          issues: error.issues
        },
        { status: 400 }
      );
    }
    if (error instanceof GitHubApiError) {
      const status = error.status === 404 ? 404 : 502;
      return documentJson(
        { error: error.message, code: error.code },
        { status }
      );
    }
    const message = error instanceof Error ? error.message : "剧本操作失败";
    return documentJson({ error: message }, { status: 500 });
  }

  /**
   * Only allow the Worker to reach a `MyAssistant` facet that this
   * directory has explicitly spawned via `createChat`. `hasSubAgent`
   * is backed by the same registry `listSubAgents` reads from, so an
   * unknown chat id gets a 404 before any child is woken.
   */
  override async onBeforeSubAgent(
    _req: Request,
    { className, name }: { className: string; name: string }
  ): Promise<Request | Response | void> {
    if (!this.hasSubAgent(className, name)) {
      return new Response(`${className} "${name}" not found`, { status: 404 });
    }
    // Fall through — framework forwards the request to the facet.
  }

  // ── Sidebar state ──────────────────────────────────────────────────

  /**
   * Build the sidebar from two sources:
   *   1. `listSubAgents(MyAssistant)` — authoritative set of chats.
   *   2. `chat_meta` — app-owned title + preview decoration.
   *
   * A chat present in the registry without a meta row still renders
   * with a default title; a meta row without a registry entry is
   * silently ignored.
   */
  private _refreshState() {
    const registry = this.listSubAgents(MyAssistant);
    const metaRows = this.sql<{
      id: string;
      title: string;
      updated_at: number;
      last_message_preview: string | null;
    }>`SELECT id, title, updated_at, last_message_preview FROM chat_meta`;
    const metaById = new Map(metaRows.map((row) => [row.id, row]));

    const chats: ChatSummary[] = registry
      .map((entry) => {
        const meta = metaById.get(entry.name);
        return {
          id: entry.name,
          title: meta?.title ?? defaultChatTitle(entry.createdAt),
          createdAt: entry.createdAt,
          updatedAt: meta?.updated_at ?? entry.createdAt,
          lastMessagePreview: meta?.last_message_preview ?? undefined
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.setState({ ...this.state, chats });
  }

  // ── Chat lifecycle (RPC from the sidebar) ──────────────────────────

  @callable()
  async createChat(opts?: { title?: string }): Promise<ChatSummary> {
    const id = nanoid(10);
    const now = Date.now();
    const title = opts?.title?.trim() || defaultChatTitle(now);

    // Spawn the facet FIRST so the registry is populated. If the
    // metadata INSERT fails for any reason, a subsequent `deleteChat`
    // or `_refreshState` will still find the chat via the registry.
    await this.subAgent(MyAssistant, id);
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (${id}, ${title}, ${now}, NULL)
    `;
    this._refreshState();
    return {
      id,
      title,
      createdAt: now,
      updatedAt: now
    };
  }

  @callable()
  async renameChat(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at)
      VALUES (${id}, ${trimmed}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at
    `;
    this._refreshState();
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    // Wipe the facet (idempotent — safe if already gone), then drop
    // its metadata. Order doesn't matter for correctness since the
    // registry is authoritative, but we do the facet first so a crash
    // between the two leaves no orphan meta rows visible.
    await this.deleteSubAgent(MyAssistant, id);
    this.sql`DELETE FROM chat_meta WHERE id = ${id}`;
    this._refreshState();
  }

  /**
   * Called by a child `MyAssistant` after every assistant turn — see
   * `MyAssistant.onChatResponse`. Keeps the sidebar preview and
   * "last active" ordering in sync with the real conversations.
   *
   * Deliberately NOT `@callable()` — this is a parent-side side effect
   * of committing a turn, not something a browser should be able to
   * trigger directly. Child→parent DO RPC doesn't need the decorator.
   * Marking it `@callable()` would let a client forge sidebar entries
   * for any chat id in their own directory.
   */
  async recordChatTurn(chatId: string, preview: string): Promise<void> {
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (
        ${chatId},
        ${defaultChatTitle(Date.now())},
        ${Date.now()},
        ${preview}
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        last_message_preview = excluded.last_message_preview
    `;
    this._refreshState();
  }

  // ── Scheduled work (declarative, directory-owned, fans out to one child) ──

  /**
   * Wall-clock timezone for declarative scheduled tasks. A real app would
   * derive this per user; the demo pins it to UTC.
   */
  override getDefaultTimezone(): string {
    return "UTC";
  }

  /**
   * Declarative scheduled work, reconciled by Think on startup. The
   * directory is a Think root, so it owns this cross-chat task directly.
   *
   * `dailySummary` is a deterministic handler (not a prompt task): it
   * picks the most-recently-updated chat and RPCs a proactive summary
   * prompt into that one child, so the user gets a single daily
   * notification attached to the conversation they last used. A real app
   * might fan out to every chat, or skip chats idle beyond a threshold.
   */
  override getScheduledTasks(): ThinkScheduledTasks {
    return {
      dailySummary: {
        schedule: "every day at 09:00",
        handler: async () => {
          const [row] = this.sql<{ id: string }>`
            SELECT id FROM chat_meta ORDER BY updated_at DESC LIMIT 1
          `;
          if (!row) return;
          const target = await this.subAgent(MyAssistant, row.id);
          await target.postDailySummaryPrompt();
        }
      }
    };
  }

  // ── Shared workspace RPC surface (called by SharedWorkspace) ─────
  //
  // Children reach the directory via `parentAgent(AssistantDirectory)`,
  // which exposes these as typed DO RPC methods. `@callable()` is
  // deliberately NOT used — the client has no business writing to
  // another chat's files via the sidebar websocket; workspace I/O is
  // LLM-tool-only. DO-to-DO RPC doesn't need the decorator.
  //
  // The surface covers the full `WorkspaceFsLike` interface from
  // `@cloudflare/shell`, which is what `createWorkspaceStateBackend`
  // needs to drive codemode's `state.*` sandbox API. That means a
  // plan from one chat can edit files the same way as a single-chat
  // app — the shared workspace is the single source of truth.
  //
  // Each method is a one-line delegate. We use
  // `Parameters<Workspace["method"]>[n]` to stay automatically in
  // sync with `@cloudflare/shell` rather than re-stating the types.

  async readFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.workspace.readFileBytes(path);
  }

  async writeFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["writeFile"]>[2]
  ): Promise<void> {
    return this.workspace.writeFile(path, content, mimeType);
  }

  async writeFileBytes(
    path: string,
    content: Parameters<Workspace["writeFileBytes"]>[1],
    mimeType?: Parameters<Workspace["writeFileBytes"]>[2]
  ): Promise<void> {
    return this.workspace.writeFileBytes(path, content, mimeType);
  }

  async appendFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["appendFile"]>[2]
  ): Promise<void> {
    return this.workspace.appendFile(path, content, mimeType);
  }

  async exists(path: string): Promise<boolean> {
    return this.workspace.exists(path);
  }

  async readDir(
    path: string,
    opts?: Parameters<Workspace["readDir"]>[1]
  ): Promise<FileInfo[]> {
    return this.workspace.readDir(path, opts);
  }

  async rm(path: string, opts?: Parameters<Workspace["rm"]>[1]): Promise<void> {
    return this.workspace.rm(path, opts);
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    return this.workspace.glob(pattern);
  }

  async mkdir(
    path: string,
    opts?: Parameters<Workspace["mkdir"]>[1]
  ): Promise<void> {
    return this.workspace.mkdir(path, opts);
  }

  async stat(path: string): Promise<FileInfo | null> {
    return this.workspace.stat(path);
  }

  async lstat(path: string): Promise<FileInfo | null> {
    return this.workspace.lstat(path);
  }

  async cp(
    src: string,
    dest: string,
    opts?: Parameters<Workspace["cp"]>[2]
  ): Promise<void> {
    return this.workspace.cp(src, dest, opts);
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.workspace.mv(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.workspace.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.workspace.readlink(path);
  }

  // ── Shared MCP surface ───────────────────────────────────────────
  //
  // The directory owns the MCP state for every chat under it:
  //   - server registry (+ OAuth client registrations) in
  //     `cf_agents_mcp_servers`
  //   - OAuth tokens via `DurableObjectOAuthClientProvider`
  //   - live connections + tool/prompt/resource caches in memory
  //
  // Browser-callable surface (`@callable()`): `addServer` /
  // `removeServer`. These go through the directory's WS connection
  // (the one `useChats()` already owns) rather than the per-chat WS,
  // so the UI talks to the same DO that holds the state.
  //
  // Child-callable surface (not `@callable()`): `listMcpToolDescriptors`
  // / `callMcpTool`. These are invoked via `parentAgent(AssistantDirectory)`
  // from `SharedMCPClient` on each chat turn.

  /**
   * Register a new MCP server for this user and kick off the initial
   * connection. If the server requires OAuth, returns the provider's
   * `authUrl` so the browser can open the popup.
   *
   * The callback URL is `/chat/mcp-callback` — resolved by the Worker
   * to this directory instance for the authenticated user. One URL
   * for every server for every chat.
   */
  @callable()
  async addServer(
    name: string,
    url: string
  ): ReturnType<AssistantDirectory["addMcpServer"]> {
    return await this.addMcpServer(name, url, {
      callbackPath: "chat/mcp-callback"
    });
  }

  @callable()
  async removeServer(id: string): Promise<void> {
    await this.removeMcpServer(id);
  }

  /**
   * Snapshot of currently-ready MCP tools across every server this
   * directory has connected. Children call this once per chat turn
   * (via `SharedMCPClient.getAITools()`) to assemble the LLM's tool
   * set.
   *
   * Waits up to `timeoutMs` for in-progress connections to become
   * ready before returning, so a chat launched right after the
   * directory wakes from hibernation still sees tools from servers
   * that are mid-handshake. `MCPClientManager.waitForConnections`
   * returns eagerly if everything is already ready.
   *
   * Deliberately NOT `@callable()` — child→parent DO RPC doesn't
   * need the decorator, and the browser reads MCP state via the
   * `CF_AGENT_MCP_SERVERS` broadcast (automatic, not this path).
   */
  async listMcpToolDescriptors(
    timeoutMs = 5_000
  ): Promise<McpToolDescriptor[]> {
    await this.mcp.waitForConnections({ timeout: timeoutMs });
    return this.mcp.listTools() as McpToolDescriptor[];
  }

  /**
   * Invoke an MCP tool. Returns the raw `CallToolResult` from the MCP
   * SDK; the child is responsible for unwrapping `isError` into a
   * thrown exception for the AI SDK's tool pipeline.
   *
   * Deliberately NOT `@callable()` — only intended to be reached via
   * `SharedMCPClient.execute(...)`. A `@callable()` here would let a
   * client invoke any MCP tool directly over the sidebar WS,
   * bypassing the agent's `beforeToolCall`/`afterToolCall` hooks.
   */
  async callMcpTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    return (await this.mcp.callTool({
      arguments: args,
      name,
      serverId
    })) as CallToolResult;
  }
}

function defaultChatTitle(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  return `New chat — ${month} ${day}`;
}

function documentJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

function numericQuery(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

async function storyRequestJson(
  request: Request
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function storyExpectedRevision(body: Record<string, unknown>): number {
  const value = body.expectedRevision;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("expectedRevision 必须是非负整数");
  }
  return value as number;
}

function storyText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} 不能为空`);
  }
  return value.trim();
}

function storyOptionalText(
  value: unknown,
  name: string,
  maximumLength: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximumLength) {
    throw new Error(`${name} 不能超过 ${maximumLength} 个字符`);
  }
  return normalized;
}

function storyUiSource(value: unknown): string {
  const allowed = new Set([
    "relationship-panel",
    "timeline-panel",
    "json-editor"
  ]);
  return typeof value === "string" && allowed.has(value)
    ? value
    : "story-panel";
}

function storyChangeSummary(
  category: "story" | "cast" | "bonds" | "timeline",
  kind: "added" | "removed" | "modified",
  key: string
): string {
  const categoryLabel = {
    story: "剧本入口",
    cast: "人物",
    bonds: "人物关系",
    timeline: "时间线"
  }[category];
  const kindLabel = { added: "新增", removed: "删除", modified: "修改" }[
    kind
  ];
  return `${kindLabel}${categoryLabel}：${key}`;
}

export function storyBranchName(directoryName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(directoryName)) {
    throw new Error("无效的剧本目录身份");
  }
  return `drafts/${directoryName}`;
}

function emptyStory(): MysteryStoryDsl {
  return {
    cast: [],
    bonds: [],
    storyline: {
      opening: "story_start",
      timeline: [
        {
          key: "story_start",
          at: "00:00",
          event: "故事尚未开始",
          end: true
        }
      ]
    }
  };
}

const INLINE_DOCUMENT_MIME_TYPES = new Set([
  "application/json",
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain"
]);

function safeDocumentContentType(value: string): string {
  const normalized = value.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function canDisplayDocumentInline(contentType: string): boolean {
  return INLINE_DOCUMENT_MIME_TYPES.has(contentType);
}

function documentParseByteLimit(
  mimeType: string,
  fileName: string
): number | null {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (normalized === "application/pdf" || /\.pdf$/i.test(fileName)) {
    return MAX_PDF_INDEX_BYTES;
  }
  if (isTextDocument(normalized, fileName)) return MAX_TEXT_INDEX_BYTES;
  return null;
}

function formatMegabytes(bytes: number): number {
  return bytes / 1024 / 1024;
}

function decodeHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
