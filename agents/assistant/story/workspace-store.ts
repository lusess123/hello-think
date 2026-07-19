import {
  createJsonLineDiff,
  createStoryBusinessDiff,
  type JsonDiffLine,
  type StoryBusinessDiff,
} from "./diff";
import type {
  GitHubAppClient,
  GitHubCommit,
  GitHubPullRequest,
  GitHubVersion,
} from "./github-app-client";
import { GitHubApiError, GitHubConflictError } from "./github-app-client";
import {
  MysteryStoryDslSchema,
  parseMysteryStoryJson,
  serializeMysteryStory,
  type MysteryStoryDsl,
} from "./schema";

export type StoryWorkspaceEventKind =
  | "initialize"
  | "update"
  | "discard"
  | "restore"
  | "commit"
  | "sync";

export interface StoryWorkspace {
  path: string;
  branch: string;
  baseCommitSha: string;
  baseStory: MysteryStoryDsl;
  baseFileExists: boolean;
  workingStory: MysteryStoryDsl;
  restoredFromSha: string | null;
  restoredFromEventId: number | null;
  remoteHeadSha: string | null;
  revision: number;
  dirty: boolean;
  modifiedBy: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoryWorkspaceEvent {
  id: number;
  path: string;
  revision: number;
  kind: StoryWorkspaceEventKind;
  actor: string;
  source: string;
  summary: string;
  baseCommitSha: string;
  restoredFromSha: string | null;
  beforeStory: MysteryStoryDsl | null;
  afterStory: MysteryStoryDsl | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  diff: StoryWorkspaceDiff;
}

export interface StoryWorkspaceDiff {
  fileStatus: "added" | "modified" | "unchanged";
  business: StoryBusinessDiff;
  json: JsonDiffLine[];
}

export interface StoryVersion extends GitHubVersion {
  story: MysteryStoryDsl;
}

export interface StoryCommitResult {
  workspace: StoryWorkspace;
  commit: GitHubCommit | null;
}

export interface StoryRepositoryClient
  extends Pick<
    GitHubAppClient,
    | "defaultBranch"
    | "ensureBranch"
    | "getRef"
    | "getCommit"
    | "getContent"
    | "commitFile"
    | "listVersions"
    | "createPullRequest"
  > {}

interface StoryWorkspaceRow {
  [key: string]: string | number | null;
  path: string;
  branch: string;
  base_commit_sha: string;
  base_story_json: string;
  base_file_exists: number;
  working_story_json: string;
  restored_from_sha: string | null;
  restored_from_event_id: number | null;
  remote_head_sha: string | null;
  revision: number;
  dirty: number;
  modified_by: string;
  source: string;
  created_at: number;
  updated_at: number;
  commit_nonce: string | null;
  commit_started_at: number | null;
  commit_message: string | null;
  commit_actor: string | null;
  commit_source: string | null;
}

interface StoryWorkspaceEventRow {
  [key: string]: string | number | null;
  id: number;
  path: string;
  revision: number;
  kind: string;
  actor: string;
  source: string;
  summary: string;
  base_commit_sha: string;
  restored_from_sha: string | null;
  before_story_json: string | null;
  after_story_json: string | null;
  metadata_json: string;
  created_at: number;
  diff_json: string;
}

interface StoryWorkspaceEventColumnRow {
  [key: string]: string | number | null;
  name: string;
}

type PendingCommitRecovery =
  | { status: "cleared"; workspace: StoryWorkspace }
  | { status: "committed"; result: StoryCommitResult }
  | {
      status: "conflict";
      workspace: StoryWorkspace;
      expectedSha: string;
      actualSha: string;
    };

export class StoryWorkspaceNotFoundError extends Error {
  readonly code = "STORY_WORKSPACE_NOT_FOUND";

  constructor(readonly path: string) {
    super(`剧本工作区不存在：${path}`);
    this.name = "StoryWorkspaceNotFoundError";
  }
}

export class StoryWorkspaceConflictError extends Error {
  readonly code = "STORY_WORKSPACE_REVISION_CONFLICT";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`剧本工作区已经更新（期望 revision ${expectedRevision}，当前 ${actualRevision}）`);
    this.name = "StoryWorkspaceConflictError";
  }
}

export class StoryCommitInProgressError extends Error {
  readonly code = "STORY_COMMIT_IN_PROGRESS";

  constructor(readonly path: string) {
    super(`剧本正在提交，请稍后再试：${path}`);
    this.name = "StoryCommitInProgressError";
  }
}

export class StoryWorkspaceRebaseConflictError extends Error {
  readonly code = "STORY_WORKSPACE_REBASE_CONFLICT";

  constructor(
    readonly previousBaseSha: string,
    readonly remoteHeadSha: string,
    readonly paths: string[]
  ) {
    super(`远端版本与工作区修改冲突：${paths.slice(0, 5).join("、")}`);
    this.name = "StoryWorkspaceRebaseConflictError";
  }
}

/**
 * Durable Object SQL-backed equivalent of a Git working tree.
 *
 * GitHub keeps confirmed history; this store keeps the unconfirmed story that
 * both the UI and LLM can see. Every mutating operation is revision-guarded.
 */
export class StoryWorkspaceStore {
  private readonly sql: SqlStorage;
  private readonly activeCommitNonces = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly github: StoryRepositoryClient,
    private readonly now: () => number = Date.now
  ) {
    this.sql = storage.sql;
    this.storage.transactionSync(() => this.ensureSchema());
  }

  async initialize(input: {
    path: string;
    branch: string;
    fromBranch?: string;
    initialStory?: MysteryStoryDsl;
    actor: string;
    source: string;
  }): Promise<StoryWorkspace> {
    const path = normalizeStoryPath(input.path);
    const existing = this.findRow(path);
    if (existing) {
      if (!existing.commit_nonce) return toWorkspace(existing);
      if (this.activeCommitNonces.has(existing.commit_nonce)) {
        return toWorkspace(existing);
      }
      const recovery = await this.reconcilePendingCommit(path, existing.commit_nonce);
      return recovery.status === "committed"
        ? recovery.result.workspace
        : recovery.workspace;
    }

    const branch = requiredText(input.branch, "branch");
    const actor = requiredText(input.actor, "actor");
    const source = requiredText(input.source, "source");
    const ref = await this.github.ensureBranch(
      branch,
      input.fromBranch?.trim() || this.github.defaultBranch
    );

    let story: MysteryStoryDsl;
    let baseFileExists = true;
    try {
      story = parseMysteryStoryJson((await this.github.getContent(path, ref.sha)).content);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404 || !input.initialStory) {
        throw error;
      }
      story = MysteryStoryDslSchema.parse(input.initialStory);
      baseFileExists = false;
    }

    const timestamp = this.now();
    const storyJson = serializeMysteryStory(story);
    const dirty = !baseFileExists;
    return this.storage.transactionSync(() => {
      // Another request can finish the GitHub I/O above while this request is
      // awaiting it. Re-check inside the transaction so only the request that
      // actually creates the row writes the initialize event.
      const concurrent = this.findRow(path);
      if (concurrent) return toWorkspace(concurrent);

      this.sql.exec(
        `INSERT OR IGNORE INTO story_workspaces (
           path, branch, base_commit_sha, base_story_json, base_file_exists,
           working_story_json, revision, dirty, modified_by, source,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        path,
        branch,
        ref.sha,
        storyJson,
        baseFileExists ? 1 : 0,
        storyJson,
        dirty ? 1 : 0,
        actor,
        source,
        timestamp,
        timestamp
      );
      const workspace = this.read(path);
      this.addEvent(
        workspace,
        "initialize",
        actor,
        source,
        "初始化剧本工作区",
        this.diff(workspace),
        null
      );
      return workspace;
    });
  }

  read(path: string): StoryWorkspace {
    const normalizedPath = normalizeStoryPath(path);
    const row = this.findRow(normalizedPath);
    if (!row) throw new StoryWorkspaceNotFoundError(normalizedPath);
    return toWorkspace(row);
  }

  getDiff(path: string): StoryWorkspaceDiff {
    return this.diff(this.read(path));
  }

  update(input: {
    path: string;
    expectedRevision: number;
    story: MysteryStoryDsl;
    actor: string;
    source: string;
    summary?: string;
  }): StoryWorkspace {
    const path = normalizeStoryPath(input.path);
    const actor = requiredText(input.actor, "actor");
    const source = requiredText(input.source, "source");
    const story = MysteryStoryDslSchema.parse(input.story);
    const workingJson = serializeMysteryStory(story);
    return this.storage.transactionSync(() => {
      const current = this.readMutable(path, input.expectedRevision);
      const baseJson = serializeMysteryStory(current.baseStory);
      const dirty = !current.baseFileExists || workingJson !== baseJson;
      const eventDiff = diffStories(current.workingStory, story);
      const updated = this.sql.exec(
        `UPDATE story_workspaces
         SET working_story_json = ?, revision = revision + 1, dirty = ?,
             restored_from_sha = NULL, restored_from_event_id = NULL,
             modified_by = ?, source = ?, updated_at = ?
         WHERE path = ? AND revision = ? AND commit_nonce IS NULL`,
        workingJson,
        dirty ? 1 : 0,
        actor,
        source,
        this.now(),
        path,
        input.expectedRevision
      );
      if (updated.rowsWritten !== 1) this.throwCurrentState(path, input.expectedRevision);
      const workspace = this.read(path);
      this.addEvent(
        workspace,
        "update",
        actor,
        source,
        eventSummary(input.summary, "更新剧本工作区"),
        eventDiff,
        current.workingStory
      );
      return workspace;
    });
  }

  discard(input: {
    path: string;
    expectedRevision: number;
    actor: string;
    source: string;
  }): StoryWorkspace {
    const path = normalizeStoryPath(input.path);
    const actor = requiredText(input.actor, "actor");
    const source = requiredText(input.source, "source");
    return this.storage.transactionSync(() => {
      const current = this.readMutable(path, input.expectedRevision);
      const eventDiff = diffStories(current.workingStory, current.baseStory);
      const updated = this.sql.exec(
        `UPDATE story_workspaces
         SET working_story_json = base_story_json, revision = revision + 1,
             dirty = CASE WHEN base_file_exists = 1 THEN 0 ELSE 1 END,
             restored_from_sha = NULL, restored_from_event_id = NULL,
             modified_by = ?, source = ?, updated_at = ?
         WHERE path = ? AND revision = ? AND commit_nonce IS NULL`,
        actor,
        source,
        this.now(),
        path,
        current.revision
      );
      if (updated.rowsWritten !== 1) this.throwCurrentState(path, input.expectedRevision);
      const workspace = this.read(path);
      this.addEvent(
        workspace,
        "discard",
        actor,
        source,
        "放弃全部未提交修改",
        eventDiff,
        current.workingStory
      );
      return workspace;
    });
  }

  async restoreToWorkspace(input: {
    path: string;
    sha: string;
    expectedRevision: number;
    actor: string;
    source: string;
  }): Promise<StoryWorkspace> {
    const path = normalizeStoryPath(input.path);
    const sha = requiredText(input.sha, "sha");
    const content = await this.github.getContent(path, sha);
    const restoredStory = parseMysteryStoryJson(content.content);
    return this.applyRestore(
      path,
      input.expectedRevision,
      restoredStory,
      sha,
      null,
      input.actor,
      input.source,
      `恢复历史版本 ${sha.slice(0, 7)}`,
      { targetSha: sha }
    );
  }

  restoreEventSnapshot(input: {
    path: string;
    eventId: number;
    expectedRevision: number;
    actor: string;
    source: string;
  }): StoryWorkspace {
    const path = normalizeStoryPath(input.path);
    if (!Number.isInteger(input.eventId) || input.eventId <= 0) {
      throw new Error("eventId 必须是正整数");
    }
    const target = this.sql
      .exec<StoryWorkspaceEventRow>(
        "SELECT * FROM story_workspace_events WHERE path = ? AND id = ?",
        path,
        input.eventId
      )
      .toArray()[0];
    if (!target) throw new Error(`剧本工作区历史事件不存在：${input.eventId}`);
    if (!target.after_story_json) {
      throw new Error(`剧本工作区历史事件没有可恢复快照：${input.eventId}`);
    }

    return this.applyRestore(
      path,
      input.expectedRevision,
      parseMysteryStoryJson(target.after_story_json),
      null,
      input.eventId,
      input.actor,
      input.source,
      `恢复工作区历史 r${target.revision}`,
      {
        targetEventId: input.eventId,
        targetRevision: target.revision,
        targetKind: target.kind,
      }
    );
  }

  async confirmCommit(input: {
    path: string;
    expectedRevision: number;
    message: string;
    actor: string;
    source: string;
  }): Promise<StoryCommitResult> {
    const path = normalizeStoryPath(input.path);
    const message = requiredText(input.message, "message");
    const actor = requiredText(input.actor, "actor");
    const source = requiredText(input.source, "source");

    const existing = this.findRow(path);
    if (!existing) throw new StoryWorkspaceNotFoundError(path);
    if (existing.commit_nonce) {
      if (this.activeCommitNonces.has(existing.commit_nonce)) {
        throw new StoryCommitInProgressError(path);
      }
      const recovery = await this.reconcilePendingCommit(path, existing.commit_nonce);
      if (recovery.status === "committed") return recovery.result;
      if (recovery.status === "conflict") {
        throw new GitHubConflictError(recovery.expectedSha, recovery.actualSha);
      }
    }

    const current = this.readMutable(path, input.expectedRevision);
    if (!current.dirty) return { workspace: current, commit: null };
    const remoteHeadSha = this.findRow(path)?.remote_head_sha;
    if (remoteHeadSha && remoteHeadSha !== current.baseCommitSha) {
      throw new GitHubConflictError(current.baseCommitSha, remoteHeadSha);
    }

    const nonce = crypto.randomUUID();
    this.storage.transactionSync(() => {
      const reserved = this.sql.exec(
        `UPDATE story_workspaces
         SET commit_nonce = ?, commit_started_at = ?, commit_message = ?,
             commit_actor = ?, commit_source = ?, remote_head_sha = NULL
         WHERE path = ? AND revision = ? AND commit_nonce IS NULL`,
        nonce,
        this.now(),
        message,
        actor,
        source,
        path,
        current.revision
      );
      if (reserved.rowsWritten !== 1) {
        this.throwCurrentState(path, input.expectedRevision);
      }
    });
    this.activeCommitNonces.add(nonce);

    try {
      const commit = await this.github.commitFile({
        path,
        branch: current.branch,
        content: serializeMysteryStory(current.workingStory),
        message,
        expectedHeadSha: current.baseCommitSha,
      });
      return this.finalizeCommit(current, nonce, commit, actor, source, message, false);
    } catch (error) {
      let recovery: PendingCommitRecovery;
      try {
        recovery = await this.reconcilePendingCommit(path, nonce);
      } catch {
        // Keep the durable nonce when GitHub cannot be inspected. The next
        // initialize/confirm call will resume reconciliation after a restart.
        throw error;
      }
      if (recovery.status === "committed") return recovery.result;
      if (recovery.status === "conflict") {
        throw new GitHubConflictError(recovery.expectedSha, recovery.actualSha);
      }
      throw error;
    } finally {
      this.activeCommitNonces.delete(nonce);
    }
  }

  /**
   * Reconciles the durable pending marker with the branch ref. This is called
   * both after an ambiguous GitHub failure and when a new Store instance sees
   * a nonce left by a terminated Worker.
   */
  private async reconcilePendingCommit(
    path: string,
    nonce: string
  ): Promise<PendingCommitRecovery> {
    const row = this.findRow(path);
    if (!row) throw new StoryWorkspaceNotFoundError(path);
    if (!row.commit_nonce) {
      return { status: "cleared", workspace: toWorkspace(row) };
    }
    if (row.commit_nonce !== nonce) throw new StoryCommitInProgressError(path);

    const pending = toWorkspace(row);
    const ref = await this.github.getRef(pending.branch);
    if (ref.sha === pending.baseCommitSha) {
      const workspace = this.clearPendingCommit(path, nonce, null);
      return { status: "cleared", workspace };
    }

    const remoteStory = parseMysteryStoryJson(
      (await this.github.getContent(path, ref.sha)).content
    );
    if (
      serializeMysteryStory(remoteStory) !==
      serializeMysteryStory(pending.workingStory)
    ) {
      const workspace = this.clearPendingCommit(path, nonce, ref.sha);
      return {
        status: "conflict",
        workspace,
        expectedSha: pending.baseCommitSha,
        actualSha: ref.sha,
      };
    }

    const commit = await this.github.getCommit(ref.sha);
    const actor = row.commit_actor?.trim() || pending.modifiedBy;
    const source = row.commit_source?.trim() || pending.source;
    const message = row.commit_message?.trim() || commit.message || "恢复未完成的剧本提交";
    return {
      status: "committed",
      result: this.finalizeCommit(
        pending,
        nonce,
        commit,
        actor,
        source,
        message,
        true
      ),
    };
  }

  private clearPendingCommit(
    path: string,
    nonce: string,
    remoteHeadSha: string | null
  ): StoryWorkspace {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE story_workspaces
         SET commit_nonce = NULL, commit_started_at = NULL,
             commit_message = NULL, commit_actor = NULL,
             commit_source = NULL, remote_head_sha = ?
         WHERE path = ? AND commit_nonce = ?`,
        remoteHeadSha,
        path,
        nonce
      );
      return this.read(path);
    });
  }

  private finalizeCommit(
    before: StoryWorkspace,
    nonce: string,
    commit: GitHubCommit,
    actor: string,
    source: string,
    message: string,
    recovered: boolean
  ): StoryCommitResult {
    const commitDiff = this.diff(before);
    return this.storage.transactionSync(() => {
      const row = this.findRow(before.path);
      if (!row) throw new StoryWorkspaceNotFoundError(before.path);
      if (row.commit_nonce !== nonce) {
        const workspace = toWorkspace(row);
        if (workspace.baseCommitSha === commit.sha && !workspace.dirty) {
          return { workspace, commit };
        }
        throw new StoryCommitInProgressError(before.path);
      }

      const committed = this.sql.exec(
        `UPDATE story_workspaces
         SET base_commit_sha = ?, base_story_json = working_story_json,
             base_file_exists = 1, revision = revision + 1, dirty = 0,
             restored_from_sha = NULL, restored_from_event_id = NULL,
             remote_head_sha = NULL, modified_by = ?, source = ?,
             updated_at = ?, commit_nonce = NULL, commit_started_at = NULL,
             commit_message = NULL, commit_actor = NULL, commit_source = NULL
         WHERE path = ? AND revision = ? AND commit_nonce = ?`,
        commit.sha,
        actor,
        source,
        this.now(),
        before.path,
        before.revision,
        nonce
      );
      if (committed.rowsWritten !== 1) {
        throw new Error("GitHub 已提交，但剧本工作区状态未能同步");
      }

      const workspace = this.read(before.path);
      this.addEvent(
        workspace,
        "commit",
        actor,
        source,
        message,
        commitDiff,
        before.baseFileExists ? before.baseStory : null,
        {
          commitSha: commit.sha,
          previousBaseSha: before.baseCommitSha,
          previousRestoredFromSha: before.restoredFromSha,
          previousRestoredFromEventId: before.restoredFromEventId,
          recovered,
        }
      );
      return { workspace, commit };
    });
  }

  /**
   * Fetches the current draft ref and rebases the uncommitted working copy on
   * top of it. Non-overlapping local/remote field edits are merged; an
   * overlapping edit leaves the workspace untouched and reports exact paths.
   */
  async syncFromRemote(input: {
    path: string;
    expectedRevision: number;
    actor: string;
    source: string;
  }): Promise<StoryWorkspace> {
    const path = normalizeStoryPath(input.path);
    const actor = requiredText(input.actor, "actor");
    const source = requiredText(input.source, "source");

    const pending = this.findRow(path);
    if (!pending) throw new StoryWorkspaceNotFoundError(path);
    if (pending.commit_nonce) {
      if (this.activeCommitNonces.has(pending.commit_nonce)) {
        throw new StoryCommitInProgressError(path);
      }
      await this.reconcilePendingCommit(path, pending.commit_nonce);
    }

    const beforeFetch = this.readMutable(path, input.expectedRevision);
    const remoteRef = await this.github.getRef(beforeFetch.branch);
    if (remoteRef.sha === beforeFetch.baseCommitSha) {
      if (!beforeFetch.remoteHeadSha) return beforeFetch;
      return this.storage.transactionSync(() => {
        this.readMutable(path, input.expectedRevision);
        this.sql.exec(
          "UPDATE story_workspaces SET remote_head_sha = NULL WHERE path = ?",
          path
        );
        return this.read(path);
      });
    }

    const remoteStory = parseMysteryStoryJson(
      (await this.github.getContent(path, remoteRef.sha)).content
    );

    return this.storage.transactionSync(() => {
      const current = this.readMutable(path, input.expectedRevision);
      const mergedStory = rebaseStory(
        current.baseStory,
        current.workingStory,
        remoteStory,
        current.baseCommitSha,
        remoteRef.sha
      );
      const beforeWorkingJson = serializeMysteryStory(current.workingStory);
      const mergedJson = serializeMysteryStory(mergedStory);
      const remoteJson = serializeMysteryStory(remoteStory);
      const dirty = mergedJson !== remoteJson;
      const eventDiff = diffStories(current.workingStory, mergedStory);
      const restoredFromSha =
        dirty && mergedJson === beforeWorkingJson ? current.restoredFromSha : null;
      const restoredFromEventId =
        dirty && mergedJson === beforeWorkingJson
          ? current.restoredFromEventId
          : null;

      const updated = this.sql.exec(
        `UPDATE story_workspaces
         SET base_commit_sha = ?, base_story_json = ?, base_file_exists = 1,
             working_story_json = ?, revision = revision + 1, dirty = ?,
             restored_from_sha = ?, restored_from_event_id = ?,
             remote_head_sha = NULL, modified_by = ?, source = ?, updated_at = ?
         WHERE path = ? AND revision = ? AND commit_nonce IS NULL`,
        remoteRef.sha,
        remoteJson,
        mergedJson,
        dirty ? 1 : 0,
        restoredFromSha,
        restoredFromEventId,
        actor,
        source,
        this.now(),
        path,
        input.expectedRevision
      );
      if (updated.rowsWritten !== 1) {
        this.throwCurrentState(path, input.expectedRevision);
      }

      const workspace = this.read(path);
      this.addEvent(
        workspace,
        "sync",
        actor,
        source,
        `同步远端版本 ${remoteRef.sha.slice(0, 7)}`,
        eventDiff,
        current.workingStory,
        {
          previousBaseSha: current.baseCommitSha,
          remoteHeadSha: remoteRef.sha,
          previousBaseStory: current.baseStory,
          remoteBaseStory: remoteStory,
          previousRestoredFromSha: current.restoredFromSha,
          previousRestoredFromEventId: current.restoredFromEventId,
        }
      );
      return workspace;
    });
  }

  async listVersions(
    path: string,
    options: { page?: number; perPage?: number } = {}
  ): Promise<GitHubVersion[]> {
    const workspace = this.read(path);
    return this.github.listVersions(workspace.branch, workspace.path, options);
  }

  async getVersion(path: string, sha: string): Promise<StoryVersion> {
    const workspace = this.read(path);
    const normalizedSha = requiredText(sha, "sha");
    const [content, versions] = await Promise.all([
      this.github.getContent(workspace.path, normalizedSha),
      this.github.listVersions(workspace.branch, workspace.path, { perPage: 100 }),
    ]);
    const metadata = versions.find((version) => version.sha === normalizedSha);
    return {
      sha: normalizedSha,
      message: metadata?.message ?? "",
      authoredAt: metadata?.authoredAt ?? null,
      authorName: metadata?.authorName ?? null,
      authorLogin: metadata?.authorLogin ?? null,
      htmlUrl: metadata?.htmlUrl ?? "",
      story: parseMysteryStoryJson(content.content),
    };
  }

  async createPullRequest(input: {
    path: string;
    title: string;
    body?: string;
    base?: string;
    draft?: boolean;
  }): Promise<GitHubPullRequest> {
    const workspace = this.read(input.path);
    if (workspace.dirty) {
      throw new Error("工作区还有未确认修改，请先提交或放弃修改");
    }
    return this.github.createPullRequest({
      title: input.title,
      body: input.body,
      head: workspace.branch,
      base: input.base,
      draft: input.draft,
    });
  }

  listEvents(
    path: string,
    limit = 100,
    beforeId?: number
  ): StoryWorkspaceEvent[] {
    const normalizedPath = normalizeStoryPath(path);
    const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const cursor =
      beforeId === undefined
        ? undefined
        : Math.max(1, Math.floor(beforeId));
    const rows = this.sql.exec<StoryWorkspaceEventRow>(
      `SELECT id, path, revision, kind, actor, source, summary,
              base_commit_sha, restored_from_sha, before_story_json,
              after_story_json, metadata_json, created_at, diff_json
       FROM story_workspace_events
       WHERE path = ?${cursor === undefined ? "" : " AND id < ?"}
       ORDER BY id DESC
       LIMIT ?`,
      normalizedPath,
      ...(cursor === undefined ? [] : [cursor]),
      boundedLimit
    );
    return [...rows].map((row) => ({
      id: row.id,
      path: row.path,
      revision: row.revision,
      kind: row.kind as StoryWorkspaceEventKind,
      actor: row.actor,
      source: row.source,
      summary: row.summary,
      baseCommitSha: row.base_commit_sha,
      restoredFromSha: row.restored_from_sha,
      beforeStory: parseOptionalStoryJson(row.before_story_json),
      afterStory: parseOptionalStoryJson(row.after_story_json),
      metadata: parseMetadata(row.metadata_json),
      createdAt: row.created_at,
      diff: JSON.parse(row.diff_json) as StoryWorkspaceDiff,
    }));
  }

  private applyRestore(
    path: string,
    expectedRevision: number,
    story: MysteryStoryDsl,
    restoredFromSha: string | null,
    restoredFromEventId: number | null,
    actorInput: string,
    sourceInput: string,
    summaryInput: string,
    metadata: Record<string, unknown>
  ): StoryWorkspace {
    const actor = requiredText(actorInput, "actor");
    const source = requiredText(sourceInput, "source");
    const storyJson = serializeMysteryStory(story);
    return this.storage.transactionSync(() => {
      const current = this.readMutable(path, expectedRevision);
      const eventDiff = diffStories(current.workingStory, story);
      const row = this.findRow(path)!;
      const dirty = !Boolean(row.base_file_exists) || storyJson !== row.base_story_json;
      const updated = this.sql.exec(
        `UPDATE story_workspaces
         SET working_story_json = ?, revision = revision + 1, dirty = ?,
             restored_from_sha = ?, restored_from_event_id = ?,
             modified_by = ?, source = ?, updated_at = ?
         WHERE path = ? AND revision = ? AND commit_nonce IS NULL`,
        storyJson,
        dirty ? 1 : 0,
        restoredFromSha,
        restoredFromEventId,
        actor,
        source,
        this.now(),
        path,
        expectedRevision
      );
      if (updated.rowsWritten !== 1) this.throwCurrentState(path, expectedRevision);
      const workspace = this.read(path);
      this.addEvent(
        workspace,
        "restore",
        actor,
        source,
        eventSummary(summaryInput, "恢复历史版本到工作区"),
        eventDiff,
        current.workingStory,
        metadata
      );
      return workspace;
    });
  }

  private readMutable(path: string, expectedRevision: number): StoryWorkspace {
    const row = this.findRow(path);
    if (!row) throw new StoryWorkspaceNotFoundError(path);
    if (row.commit_nonce) throw new StoryCommitInProgressError(path);
    if (row.revision !== expectedRevision) {
      throw new StoryWorkspaceConflictError(expectedRevision, row.revision);
    }
    return toWorkspace(row);
  }

  private throwCurrentState(path: string, expectedRevision: number): never {
    const row = this.findRow(path);
    if (!row) throw new StoryWorkspaceNotFoundError(path);
    if (row.commit_nonce) throw new StoryCommitInProgressError(path);
    throw new StoryWorkspaceConflictError(expectedRevision, row.revision);
  }

  private findRow(path: string): StoryWorkspaceRow | undefined {
    return this.sql
      .exec<StoryWorkspaceRow>("SELECT * FROM story_workspaces WHERE path = ?", path)
      .toArray()[0];
  }

  private diff(workspace: StoryWorkspace): StoryWorkspaceDiff {
    const beforeJson = serializeMysteryStory(workspace.baseStory);
    const afterJson = serializeMysteryStory(workspace.workingStory);
    if (!workspace.baseFileExists) {
      const business = initialBusinessDiff(workspace.workingStory);
      return {
        fileStatus: "added",
        business,
        json: createJsonLineDiff("", afterJson),
      };
    }
    return {
      fileStatus: workspace.dirty ? "modified" : "unchanged",
      business: createStoryBusinessDiff(workspace.baseStory, workspace.workingStory),
      json: createJsonLineDiff(beforeJson, afterJson),
    };
  }

  private addEvent(
    workspace: StoryWorkspace,
    kind: StoryWorkspaceEventKind,
    actor: string,
    source: string,
    summary: string,
    diff: StoryWorkspaceDiff,
    beforeStory: MysteryStoryDsl | null,
    metadata: Record<string, unknown> = {}
  ): void {
    this.sql.exec(
      `INSERT INTO story_workspace_events (
         path, revision, kind, actor, source, summary, base_commit_sha,
         restored_from_sha, before_story_json, after_story_json,
         metadata_json, created_at, diff_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      workspace.path,
      workspace.revision,
      kind,
      actor,
      source,
      eventSummary(summary, kind),
      workspace.baseCommitSha,
      workspace.restoredFromSha,
      beforeStory ? serializeMysteryStory(beforeStory) : null,
      serializeMysteryStory(workspace.workingStory),
      JSON.stringify(metadata),
      this.now(),
      JSON.stringify(diff)
    );
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS story_workspaces (
        path               TEXT PRIMARY KEY,
        branch             TEXT NOT NULL,
        base_commit_sha    TEXT NOT NULL,
        base_story_json    TEXT NOT NULL,
        base_file_exists   INTEGER NOT NULL CHECK(base_file_exists IN (0, 1)),
        working_story_json TEXT NOT NULL,
        restored_from_sha  TEXT,
        restored_from_event_id INTEGER,
        remote_head_sha    TEXT,
        revision           INTEGER NOT NULL DEFAULT 0,
        dirty              INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0, 1)),
        modified_by        TEXT NOT NULL,
        source             TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        commit_nonce       TEXT,
        commit_started_at  INTEGER,
        commit_message     TEXT,
        commit_actor       TEXT,
        commit_source      TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS story_workspace_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT NOT NULL,
        revision   INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        actor      TEXT NOT NULL,
        source     TEXT NOT NULL,
        summary    TEXT NOT NULL DEFAULT '',
        base_commit_sha   TEXT NOT NULL DEFAULT '',
        restored_from_sha TEXT,
        before_story_json TEXT,
        after_story_json  TEXT,
        metadata_json     TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        diff_json  TEXT NOT NULL,
        FOREIGN KEY(path) REFERENCES story_workspaces(path) ON DELETE CASCADE
      )
    `);
    this.ensureColumn("story_workspaces", "restored_from_sha", "TEXT");
    this.ensureColumn("story_workspaces", "restored_from_event_id", "INTEGER");
    this.ensureColumn("story_workspaces", "remote_head_sha", "TEXT");
    this.ensureColumn("story_workspaces", "commit_started_at", "INTEGER");
    this.ensureColumn("story_workspaces", "commit_message", "TEXT");
    this.ensureColumn("story_workspaces", "commit_actor", "TEXT");
    this.ensureColumn("story_workspaces", "commit_source", "TEXT");
    this.ensureColumn(
      "story_workspace_events",
      "summary",
      "TEXT NOT NULL DEFAULT ''"
    );
    this.ensureColumn(
      "story_workspace_events",
      "base_commit_sha",
      "TEXT NOT NULL DEFAULT ''"
    );
    this.ensureColumn("story_workspace_events", "restored_from_sha", "TEXT");
    this.ensureColumn("story_workspace_events", "before_story_json", "TEXT");
    this.ensureColumn("story_workspace_events", "after_story_json", "TEXT");
    this.ensureColumn(
      "story_workspace_events",
      "metadata_json",
      "TEXT NOT NULL DEFAULT '{}'"
    );
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS story_workspace_events_path
      ON story_workspace_events(path, id DESC)
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.sql
      .exec<StoryWorkspaceEventColumnRow>(`PRAGMA table_info(${table})`)
      .toArray();
    if (!columns.some((entry) => entry.name === column)) {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function toWorkspace(row: StoryWorkspaceRow): StoryWorkspace {
  return {
    path: row.path,
    branch: row.branch,
    baseCommitSha: row.base_commit_sha,
    baseStory: parseMysteryStoryJson(row.base_story_json),
    baseFileExists: Boolean(row.base_file_exists),
    workingStory: parseMysteryStoryJson(row.working_story_json),
    restoredFromSha: row.restored_from_sha,
    restoredFromEventId: row.restored_from_event_id,
    remoteHeadSha: row.remote_head_sha,
    revision: row.revision,
    dirty: Boolean(row.dirty),
    modifiedBy: row.modified_by,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeStoryPath(path: string): string {
  const normalized = requiredText(path, "path").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.endsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`无效的剧本路径：${path}`);
  }
  return normalized;
}

function requiredText(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function eventSummary(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).slice(0, 500);
}

function parseOptionalStoryJson(value: string | null): MysteryStoryDsl | null {
  if (!value) return null;
  return parseMysteryStoryJson(value);
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function diffStories(
  before: MysteryStoryDsl,
  after: MysteryStoryDsl
): StoryWorkspaceDiff {
  const beforeJson = serializeMysteryStory(before);
  const afterJson = serializeMysteryStory(after);
  return {
    fileStatus: beforeJson === afterJson ? "unchanged" : "modified",
    business: createStoryBusinessDiff(before, after),
    json: createJsonLineDiff(beforeJson, afterJson),
  };
}

const missingValue = Symbol("missing-story-value");
type MergeValue = unknown | typeof missingValue;

function rebaseStory(
  base: MysteryStoryDsl,
  local: MysteryStoryDsl,
  remote: MysteryStoryDsl,
  previousBaseSha: string,
  remoteHeadSha: string
): MysteryStoryDsl {
  const conflicts: string[] = [];
  const merged = mergeStoryValue(base, local, remote, "", conflicts);
  if (conflicts.length || merged === missingValue) {
    throw new StoryWorkspaceRebaseConflictError(
      previousBaseSha,
      remoteHeadSha,
      conflicts.length ? conflicts : ["/"]
    );
  }
  return MysteryStoryDslSchema.parse(merged);
}

function mergeStoryValue(
  base: MergeValue,
  local: MergeValue,
  remote: MergeValue,
  path: string,
  conflicts: string[]
): MergeValue {
  if (sameMergeValue(local, base)) return remote;
  if (sameMergeValue(remote, base)) return local;
  if (sameMergeValue(local, remote)) return local;

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    if (base.length !== local.length || base.length !== remote.length) {
      conflicts.push(path || "/");
      return local;
    }
    return base.map((baseValue, index) =>
      mergeStoryValue(
        baseValue,
        local[index],
        remote[index],
        `${path}/${index}`,
        conflicts
      )
    );
  }

  if (isPlainRecord(base) && isPlainRecord(local) && isPlainRecord(remote)) {
    const merged: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    for (const key of keys) {
      const value = mergeStoryValue(
        Object.hasOwn(base, key) ? base[key] : missingValue,
        Object.hasOwn(local, key) ? local[key] : missingValue,
        Object.hasOwn(remote, key) ? remote[key] : missingValue,
        `${path}/${escapeJsonPointer(key)}`,
        conflicts
      );
      if (value !== missingValue) merged[key] = value;
    }
    return merged;
  }

  conflicts.push(path || "/");
  return local;
}

function sameMergeValue(left: MergeValue, right: MergeValue): boolean {
  if (left === missingValue || right === missingValue) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainRecord(value: MergeValue): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function initialBusinessDiff(story: MysteryStoryDsl): StoryBusinessDiff {
  const storyChange = [{
    kind: "added" as const,
    key: "storyline",
    after: { opening: story.storyline.opening },
    changedFields: ["opening"],
  }];
  const cast = story.cast.map((person) => ({
    kind: "added" as const,
    key: person.key,
    after: person,
    changedFields: Object.keys(person),
  }));
  const bonds = story.bonds.map((bond, index) => ({
    kind: "added" as const,
    key: `${bond.source}→${bond.target}${index ? `#${index + 1}` : ""}`,
    after: bond,
    changedFields: Object.keys(bond),
  }));
  const timeline = story.storyline.timeline.map((node) => ({
    kind: "added" as const,
    key: node.key,
    after: node,
    changedFields: Object.keys(node),
  }));
  const total = storyChange.length + cast.length + bonds.length + timeline.length;
  return {
    story: storyChange,
    cast,
    bonds,
    timeline,
    summary: { added: total, removed: 0, modified: 0, total },
  };
}
