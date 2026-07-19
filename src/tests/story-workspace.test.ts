import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { serializeMysteryStory, type MysteryStoryDsl } from "../../agents/assistant/story/schema";
import {
  GitHubApiError,
  GitHubConflictError,
} from "../../agents/assistant/story/github-app-client";
import {
  StoryCommitInProgressError,
  StoryWorkspaceConflictError,
  StoryWorkspaceRebaseConflictError,
  StoryWorkspaceStore,
  type StoryRepositoryClient,
} from "../../agents/assistant/story/workspace-store";
import type { StoryLayout } from "../story/types";
import { uniqueDirectoryName } from "./helpers";

function story(): MysteryStoryDsl {
  return {
    cast: [
      { key: "detective", name: "林川", identity: "刑警" },
      { key: "owner", name: "周明", identity: "仓库老板" },
    ],
    bonds: [{ source: "detective", relation: "friend", target: "owner" }],
    storyline: {
      opening: "arrival",
      timeline: [
        { key: "arrival", at: "21:30", actor: "detective", event: "抵达仓库", end: true },
      ],
    },
  };
}

function layout(nodes: StoryLayout["nodes"] = {}): StoryLayout {
  return { version: 1, nodes };
}

function repository(overrides: Partial<StoryRepositoryClient> = {}): StoryRepositoryClient {
  const getContent = overrides.getContent ?? vi.fn(async (path: string) => ({
    path,
    sha: "blob-a",
    content: serializeMysteryStory(story()),
  }));
  const commitFile = overrides.commitFile ?? vi.fn(async (input) => ({
    sha: "commit-b",
    treeSha: "tree-b",
    message: input.message,
  }));
  return {
    defaultBranch: "main",
    ensureBranch: vi.fn(async (branch: string) => ({ ref: `refs/heads/${branch}`, sha: "head-a" })),
    getRef: vi.fn(async (branch: string) => ({ ref: `refs/heads/${branch}`, sha: "head-a" })),
    getCommit: vi.fn(async (sha: string) => ({
      sha,
      treeSha: `tree-${sha}`,
      message: "测试提交",
    })),
    listVersions: vi.fn(async () => []),
    createPullRequest: vi.fn(async () => ({
      number: 1,
      url: "https://api.github.test/pulls/1",
      htmlUrl: "https://github.test/pulls/1",
      state: "open",
    })),
    ...overrides,
    getContent: vi.fn(async (path: string, ref?: string) => {
      const content = await getContent(path, ref);
      if (path.endsWith(".layout.json")) {
        const parsed = JSON.parse(content.content) as Record<string, unknown>;
        if (parsed.version !== 1 || typeof parsed.nodes !== "object") {
          throw new GitHubApiError(404, "GET", path, "Not Found");
        }
      }
      return content;
    }),
    commitFile,
    commitFiles: overrides.commitFiles ?? vi.fn(async (input) => {
      const file = input.files.find(({ path }) => !path.endsWith(".layout.json"));
      if (!file) throw new Error("缺少 story.json");
      return commitFile({
        path: file.path,
        content: file.content,
        branch: input.branch,
        message: input.message,
        expectedHeadSha: input.expectedHeadSha,
      });
    }),
  };
}

async function inStore<T>(
  repo: StoryRepositoryClient,
  callback: (
    store: StoryWorkspaceStore,
    storage: DurableObjectStorage
  ) => T | Promise<T>
): Promise<T> {
  const stub = env.AssistantDirectory.get(
    env.AssistantDirectory.idFromName(uniqueDirectoryName("story-workspace"))
  );
  return runInDurableObject(stub, (_instance, state) =>
    callback(
      new StoryWorkspaceStore(state.storage, repo, () => 1_800_000_000_000),
      state.storage
    )
  );
}

describe("StoryWorkspaceStore", () => {
  it("treats a missing sidecar as a clean empty layout and versions layout edits", async () => {
    const result = await inStore(repository(), async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const moved = store.updateLayout({
        path: initialized.path,
        expectedRevision: initialized.revision,
        layout: layout({ "person:detective": { x: 120, y: 80 } }),
        actor: "user:tester",
        source: "design-layout",
        summary: "移动调查员节点",
      });
      const discarded = store.discard({
        path: moved.path,
        expectedRevision: moved.revision,
        actor: "user:tester",
        source: "ui-discard",
      });
      return { initialized, moved, discarded, events: store.listEvents(moved.path) };
    });

    expect(result.initialized).toMatchObject({
      dirty: false,
      baseLayoutFileExists: false,
      baseLayout: { version: 1, nodes: {} },
      layout: { version: 1, nodes: {} },
    });
    expect(result.moved).toMatchObject({ revision: 1, dirty: true });
    expect(result.moved.layout.nodes["person:detective"]).toEqual({ x: 120, y: 80 });
    expect(result.events[1]).toMatchObject({
      kind: "update",
      summary: "移动调查员节点",
      beforeLayout: { version: 1, nodes: {} },
      afterLayout: {
        nodes: { "person:detective": { x: 120, y: 80 } },
      },
      diff: {
        layout: [{ id: "person:detective", after: { x: 120, y: 80 } }],
      },
    });
    expect(result.discarded).toMatchObject({
      revision: 2,
      dirty: false,
      layout: { version: 1, nodes: {} },
    });
    expect(result.events[0]).toMatchObject({
      kind: "discard",
      beforeLayout: {
        nodes: { "person:detective": { x: 120, y: 80 } },
      },
      afterLayout: { version: 1, nodes: {} },
    });
  });

  it("migrates legacy SQLite rows and events to empty layout snapshots", async () => {
    const stub = env.AssistantDirectory.get(
      env.AssistantDirectory.idFromName(uniqueDirectoryName("legacy-story-layout"))
    );
    const result = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE story_workspaces (
          path TEXT PRIMARY KEY,
          branch TEXT NOT NULL,
          base_commit_sha TEXT NOT NULL,
          base_story_json TEXT NOT NULL,
          base_file_exists INTEGER NOT NULL,
          working_story_json TEXT NOT NULL,
          restored_from_sha TEXT,
          restored_from_event_id INTEGER,
          remote_head_sha TEXT,
          revision INTEGER NOT NULL,
          dirty INTEGER NOT NULL,
          modified_by TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          commit_nonce TEXT,
          commit_started_at INTEGER,
          commit_message TEXT,
          commit_actor TEXT,
          commit_source TEXT
        );
        CREATE TABLE story_workspace_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL,
          revision INTEGER NOT NULL,
          kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          base_commit_sha TEXT NOT NULL,
          restored_from_sha TEXT,
          before_story_json TEXT,
          after_story_json TEXT,
          metadata_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          diff_json TEXT NOT NULL
        )
      `);
      const storyJson = serializeMysteryStory(story());
      state.storage.sql.exec(
        `INSERT INTO story_workspaces (
           path, branch, base_commit_sha, base_story_json, base_file_exists,
           working_story_json, revision, dirty, modified_by, source,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, 0, 0, ?, ?, 1, 1)`,
        "stories/default/story.json",
        "drafts/tester",
        "head-a",
        storyJson,
        storyJson,
        "user:tester",
        "panel"
      );
      state.storage.sql.exec(
        `INSERT INTO story_workspace_events (
           path, revision, kind, actor, source, summary, base_commit_sha,
           before_story_json, after_story_json, metadata_json, created_at,
           diff_json
         ) VALUES (?, 0, 'initialize', ?, ?, ?, ?, NULL, ?, '{}', 1, ?)`,
        "stories/default/story.json",
        "user:tester",
        "panel",
        "旧初始化事件",
        "head-a",
        storyJson,
        JSON.stringify({
          fileStatus: "unchanged",
          business: {
            story: [], cast: [], bonds: [], timeline: [],
            summary: { added: 0, removed: 0, modified: 0, total: 0 },
          },
          json: [],
        })
      );

      const store = new StoryWorkspaceStore(state.storage, repository());
      return {
        workspace: store.read("stories/default/story.json"),
        event: store.listEvents("stories/default/story.json")[0],
      };
    });

    expect(result.workspace).toMatchObject({
      dirty: false,
      baseLayoutFileExists: false,
      baseLayout: { version: 1, nodes: {} },
      layout: { version: 1, nodes: {} },
    });
    expect(result.event).toMatchObject({
      beforeLayout: null,
      afterLayout: null,
      diff: { layout: [] },
    });
  });

  it("commits story.json and story.layout.json through one Git commit", async () => {
    const commitFiles = vi.fn<StoryRepositoryClient["commitFiles"]>(async (input) => ({
      sha: "commit-layout",
      treeSha: "tree-layout",
      message: input.message,
    }));
    const result = await inStore(repository({ commitFiles }), async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const moved = store.updateLayout({
        path: initialized.path,
        expectedRevision: initialized.revision,
        layout: layout({ opening: { x: 400, y: 360 } }),
        actor: "user:tester",
        source: "design-layout",
      });
      return store.confirmCommit({
        path: moved.path,
        expectedRevision: moved.revision,
        message: "保存画板布局",
        actor: "user:tester",
        source: "ui-confirmation",
      });
    });

    expect(commitFiles).toHaveBeenCalledOnce();
    expect(commitFiles.mock.calls[0]![0].files.map(({ path }) => path)).toEqual([
      "stories/default/story.json",
      "stories/default/story.layout.json",
    ]);
    expect(JSON.parse(commitFiles.mock.calls[0]![0].files[1]!.content)).toEqual(
      layout({ opening: { x: 400, y: 360 } })
    );
    expect(result.workspace).toMatchObject({
      baseCommitSha: "commit-layout",
      baseLayoutFileExists: true,
      dirty: false,
      baseLayout: { nodes: { opening: { x: 400, y: 360 } } },
    });
  });

  it("merges story and layout commit history without duplicates in newest-first order", async () => {
    const shared = {
      sha: "commit-shared",
      message: "同时修改内容与布局",
      authoredAt: "2026-07-19T09:00:00.000Z",
      authorName: "tester",
      authorLogin: "tester",
      htmlUrl: "https://example.com/shared",
    };
    const storyOnly = {
      ...shared,
      sha: "commit-story",
      message: "只修改内容",
      authoredAt: "2026-07-19T08:00:00.000Z",
      htmlUrl: "https://example.com/story",
    };
    const layoutOnly = {
      ...shared,
      sha: "commit-layout",
      message: "只修改布局",
      authoredAt: "2026-07-19T10:00:00.000Z",
      htmlUrl: "https://example.com/layout",
    };
    const listVersions = vi.fn(async (
      _branch: string,
      path: string,
      options: { page?: number; perPage?: number } = {},
    ) => {
      const versions = path.endsWith(".layout.json")
        ? [layoutOnly, shared]
        : [shared, storyOnly];
      const page = options.page ?? 1;
      const perPage = options.perPage ?? 30;
      return versions.slice((page - 1) * perPage, page * perPage);
    });

    const result = await inStore(repository({ listVersions }), async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      return {
        firstPage: await store.listVersions(initialized.path, { page: 1, perPage: 2 }),
        secondPage: await store.listVersions(initialized.path, { page: 2, perPage: 2 }),
      };
    });

    expect(result.firstPage.map(({ sha }) => sha)).toEqual([
      "commit-layout",
      "commit-shared",
    ]);
    expect(result.secondPage.map(({ sha }) => sha)).toEqual(["commit-story"]);
    expect(new Set(listVersions.mock.calls.map(([, path]) => path))).toEqual(
      new Set([
        "stories/default/story.json",
        "stories/default/story.layout.json",
      ]),
    );
  });

  it("restores layout from event snapshots and historical Git versions", async () => {
    const historicalLayout = layout({ "timeline:arrival": { x: 510, y: 620 } });
    const repo = repository({
      getContent: vi.fn(async (path: string, ref: string) => {
        if (path.endsWith(".layout.json")) {
          if (ref === "old-sha") {
            return { path, sha: "layout-old", content: JSON.stringify(historicalLayout) };
          }
          throw new GitHubApiError(404, "GET", path, "Not Found");
        }
        return {
          path,
          sha: `blob-${ref}`,
          content: serializeMysteryStory(story()),
        };
      }),
    });

    const result = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const first = store.updateLayout({
        path: initialized.path,
        expectedRevision: initialized.revision,
        layout: layout({ "person:detective": { x: 100, y: 120 } }),
        actor: "user:tester",
        source: "design-layout",
      });
      const firstEvent = store.listEvents(first.path)[0]!;
      const second = store.updateLayout({
        path: first.path,
        expectedRevision: first.revision,
        layout: layout({ "person:detective": { x: 220, y: 240 } }),
        actor: "user:tester",
        source: "design-layout",
      });
      const eventRestored = store.restoreEventSnapshot({
        path: second.path,
        eventId: firstEvent.id,
        expectedRevision: second.revision,
        actor: "user:tester",
        source: "ui-event-restore",
      });
      const version = await store.getVersion(second.path, "old-sha");
      const versionRestored = await store.restoreToWorkspace({
        path: second.path,
        sha: "old-sha",
        expectedRevision: eventRestored.revision,
        actor: "user:tester",
        source: "ui-history-restore",
      });
      return { eventRestored, version, versionRestored };
    });

    expect(result.eventRestored.layout).toEqual(
      layout({ "person:detective": { x: 100, y: 120 } })
    );
    expect(result.version.layout).toEqual(historicalLayout);
    expect(result.versionRestored).toMatchObject({
      restoredFromSha: "old-sha",
      layout: historicalLayout,
    });
  });

  it("rebases non-overlapping local and remote layout moves", async () => {
    let remoteHead = "head-a";
    const baseLayout = layout({
      "person:detective": { x: 100, y: 100 },
      "timeline:arrival": { x: 300, y: 400 },
    });
    const remoteLayout = layout({
      "person:detective": { x: 100, y: 100 },
      "timeline:arrival": { x: 360, y: 400 },
    });
    const repo = repository({
      getRef: vi.fn(async (branch: string) => ({
        ref: `refs/heads/${branch}`,
        sha: remoteHead,
      })),
      getContent: vi.fn(async (path: string, ref: string) => ({
        path,
        sha: `blob-${ref}`,
        content: path.endsWith(".layout.json")
          ? JSON.stringify(ref === "head-remote" ? remoteLayout : baseLayout)
          : serializeMysteryStory(story()),
      })),
    });

    const synced = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const local = store.updateLayout({
        path: initialized.path,
        expectedRevision: initialized.revision,
        layout: layout({
          "person:detective": { x: 140, y: 100 },
          "timeline:arrival": { x: 300, y: 400 },
        }),
        actor: "user:tester",
        source: "design-layout",
      });
      remoteHead = "head-remote";
      return store.syncFromRemote({
        path: local.path,
        expectedRevision: local.revision,
        actor: "user:tester",
        source: "ui-sync",
      });
    });

    expect(synced).toMatchObject({ baseCommitSha: "head-remote", dirty: true });
    expect(synced.baseLayout).toEqual(remoteLayout);
    expect(synced.layout).toEqual(layout({
      "person:detective": { x: 140, y: 100 },
      "timeline:arrival": { x: 360, y: 400 },
    }));
  });

  it("keeps UI/agent edits uncommitted until the user confirms", async () => {
    const commitFile = vi.fn<StoryRepositoryClient["commitFile"]>(async (input) => ({
      sha: "commit-b",
      treeSha: "tree-b",
      message: input.message,
    }));
    const repo = repository({ commitFile });

    const result = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "story-panel",
      });
      const changed = structuredClone(initialized.workingStory);
      changed.bonds[0].relation = "rival";
      const updated = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: changed,
        actor: "agent:chat-a",
        source: "agent",
      });
      const beforeConfirmationCalls = commitFile.mock.calls.length;
      const diff = store.getDiff(updated.path);
      const committed = await store.confirmCommit({
        path: updated.path,
        expectedRevision: updated.revision,
        message: "调整人物关系",
        actor: "user:tester",
        source: "diff-confirmation",
      });
      return {
        initialized,
        updated,
        beforeConfirmationCalls,
        diff,
        committed,
        events: store.listEvents(updated.path),
      };
    });

    expect(result.initialized.dirty).toBe(false);
    expect(result.updated).toMatchObject({ revision: 1, dirty: true, modifiedBy: "agent:chat-a" });
    expect(result.beforeConfirmationCalls).toBe(0);
    expect(result.diff.business.bonds[0]).toMatchObject({
      kind: "modified",
      changedFields: ["relation"],
    });
    expect(result.committed.workspace).toMatchObject({
      baseCommitSha: "commit-b",
      revision: 2,
      dirty: false,
    });
    expect(commitFile).toHaveBeenCalledOnce();
    expect(result.events.map((event) => event.kind)).toEqual(["commit", "update", "initialize"]);
    expect(result.events[0]).toMatchObject({
      baseCommitSha: "commit-b",
      beforeStory: {
        bonds: [expect.objectContaining({ relation: "friend" })],
      },
      afterStory: {
        bonds: [expect.objectContaining({ relation: "rival" })],
      },
      metadata: {
        previousBaseSha: "head-a",
        commitSha: "commit-b",
        recovered: false,
      },
    });
  });

  it("does not reconcile away a nonce while its commit request is still active", async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let finishCommit!: (commit: {
      sha: string;
      treeSha: string;
      message: string;
    }) => void;
    const commitFile = vi.fn<StoryRepositoryClient["commitFile"]>(async (input) => {
      signalStarted();
      return new Promise((resolve) => {
        finishCommit = resolve;
      }).then((commit) => ({ ...commit, message: input.message }));
    });
    const getRef = vi.fn(async (branch: string) => ({
      ref: `refs/heads/${branch}`,
      sha: "head-a",
    }));

    const result = await inStore(repository({ commitFile, getRef }), async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(initialized.workingStory);
      changed.cast[0].identity = "提交中的修改";
      const updated = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: changed,
        actor: "user:tester",
        source: "relationship-panel",
      });
      const committing = store.confirmCommit({
        path: updated.path,
        expectedRevision: updated.revision,
        message: "慢速提交",
        actor: "user:tester",
        source: "ui-confirmation",
      });
      await started;

      const duringCommit = await store.initialize({
        path: updated.path,
        branch: "drafts/tester",
        actor: "system:tester",
        source: "initialize",
      });
      const mutationError = (() => {
        try {
          store.discard({
            path: updated.path,
            expectedRevision: updated.revision,
            actor: "user:tester",
            source: "ui-discard",
          });
        } catch (caught) {
          return caught;
        }
      })();

      finishCommit({ sha: "commit-b", treeSha: "tree-b", message: "慢速提交" });
      const committed = await committing;
      return { duringCommit, mutationError, committed };
    });

    expect(result.duringCommit).toMatchObject({ revision: 1, dirty: true });
    expect(result.mutationError).toBeInstanceOf(StoryCommitInProgressError);
    expect(result.committed.workspace).toMatchObject({
      revision: 2,
      baseCommitSha: "commit-b",
      dirty: false,
    });
    expect(getRef).not.toHaveBeenCalled();
  });

  it("rejects stale revisions instead of silently overwriting another editor", async () => {
    const repo = repository();
    const error = await inStore(repo, async (store) => {
      const workspace = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(workspace.workingStory);
      changed.cast[0].identity = "重案组刑警";
      store.update({
        path: workspace.path,
        expectedRevision: workspace.revision,
        story: changed,
        actor: "user:tester",
        source: "panel",
      });
      return Promise.resolve().then(() =>
        store.update({
          path: workspace.path,
          expectedRevision: workspace.revision,
          story: changed,
          actor: "agent:chat-b",
          source: "agent",
        })
      ).catch((caught) => caught);
    });

    expect(error).toBeInstanceOf(StoryWorkspaceConflictError);
    expect(error).toMatchObject({ expectedRevision: 0, actualRevision: 1 });
  });

  it("records a human summary and the incremental diff for every edit", async () => {
    const result = await inStore(repository(), async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const identityEdit = structuredClone(initialized.workingStory);
      identityEdit.cast[0].identity = "重案组刑警";
      const first = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: identityEdit,
        actor: "agent:chat-a",
        source: "agent",
        summary: "补充调查员身份",
      });
      const nameEdit = structuredClone(first.workingStory);
      nameEdit.cast[0].name = "林川川";
      store.update({
        path: first.path,
        expectedRevision: first.revision,
        story: nameEdit,
        actor: "user:tester",
        source: "relationship-panel",
        summary: "修正人物姓名",
      });
      return store.listEvents(initialized.path);
    });

    expect(result[0]).toMatchObject({
      kind: "update",
      actor: "user:tester",
      summary: "修正人物姓名",
      diff: {
        business: {
          cast: [
            expect.objectContaining({
              key: "detective",
              changedFields: ["name"],
            }),
          ],
        },
      },
    });
    expect(result[1]).toMatchObject({
      kind: "update",
      actor: "agent:chat-a",
      summary: "补充调查员身份",
      diff: {
        business: {
          cast: [
            expect.objectContaining({
              key: "detective",
              changedFields: ["identity"],
            }),
          ],
        },
      },
    });
    expect(result[0].beforeStory.cast[0]).toMatchObject({
      name: "林川",
      identity: "重案组刑警",
    });
    expect(result[0].afterStory.cast[0]).toMatchObject({
      name: "林川川",
      identity: "重案组刑警",
    });
  });

  it("rolls back the workspace mutation when its audit event cannot be written", async () => {
    const result = await inStore(repository(), async (store, storage) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      storage.sql.exec(`
        CREATE TRIGGER reject_story_update_event
        BEFORE INSERT ON story_workspace_events
        WHEN NEW.kind = 'update'
        BEGIN
          SELECT RAISE(ABORT, 'audit event write failed');
        END
      `);
      const changed = structuredClone(initialized.workingStory);
      changed.cast[0].identity = "不应被保存";
      const error = (() => {
        try {
          store.update({
            path: initialized.path,
            expectedRevision: initialized.revision,
            story: changed,
            actor: "user:tester",
            source: "relationship-panel",
          });
        } catch (caught) {
          return caught;
        }
      })();
      return {
        error,
        workspace: store.read(initialized.path),
        events: store.listEvents(initialized.path),
      };
    });

    expect(String(result.error)).toContain("audit event write failed");
    expect(result.workspace).toMatchObject({ revision: 0, dirty: false });
    expect(result.workspace.workingStory.cast[0].identity).toBe("刑警");
    expect(result.events.map((event) => event.kind)).toEqual(["initialize"]);
  });

  it("keeps the discarded content in the audit event", async () => {
    const event = await inStore(repository(), async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(initialized.workingStory);
      changed.cast[0].identity = "即将被放弃的身份";
      const updated = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: changed,
        actor: "user:tester",
        source: "relationship-panel",
        summary: "临时修改身份",
      });
      store.discard({
        path: updated.path,
        expectedRevision: updated.revision,
        actor: "user:tester",
        source: "ui-discard",
      });
      return store.listEvents(updated.path)[0];
    });

    expect(event).toMatchObject({
      kind: "discard",
      summary: "放弃全部未提交修改",
      baseCommitSha: "head-a",
      beforeStory: {
        cast: expect.arrayContaining([
          expect.objectContaining({ identity: "即将被放弃的身份" }),
        ]),
      },
      afterStory: {
        cast: expect.arrayContaining([
          expect.objectContaining({ identity: "刑警" }),
        ]),
      },
      diff: {
        business: {
          cast: [expect.objectContaining({ changedFields: ["identity"] })],
        },
      },
    });
  });

  it("restores a historical commit into the working copy without auto-committing", async () => {
    const historical = story();
    historical.cast[0].identity = "旧案调查员";
    const commitFile = vi.fn<StoryRepositoryClient["commitFile"]>();
    const repo = repository({
      commitFile,
      getContent: vi.fn(async (path: string, ref: string) => ({
        path,
        sha: `blob-${ref}`,
        content: serializeMysteryStory(ref === "old-sha" ? historical : story()),
      })),
    });

    const restored = await inStore(repo, async (store) => {
      const workspace = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      return store.restoreToWorkspace({
        path: workspace.path,
        sha: "old-sha",
        expectedRevision: workspace.revision,
        actor: "user:tester",
        source: "history",
      });
    });

    expect(restored).toMatchObject({
      revision: 1,
      dirty: true,
      restoredFromSha: "old-sha",
    });
    expect(restored.workingStory.cast[0].identity).toBe("旧案调查员");
    expect(commitFile).not.toHaveBeenCalled();
  });

  it("restores an audited workspace event snapshot with durable provenance", async () => {
    const result = await inStore(repository(), async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const firstStory = structuredClone(initialized.workingStory);
      firstStory.cast[0].identity = "第一版工作区快照";
      const first = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: firstStory,
        actor: "agent:chat-a",
        source: "agent",
        summary: "生成第一版快照",
      });
      const firstEvent = store.listEvents(first.path)[0];

      const secondStory = structuredClone(first.workingStory);
      secondStory.cast[0].identity = "第二版工作区快照";
      const second = store.update({
        path: first.path,
        expectedRevision: first.revision,
        story: secondStory,
        actor: "user:tester",
        source: "relationship-panel",
        summary: "生成第二版快照",
      });
      const restored = store.restoreEventSnapshot({
        path: second.path,
        eventId: firstEvent.id,
        expectedRevision: second.revision,
        actor: "user:tester",
        source: "ui-event-restore",
      });
      return {
        restored,
        firstEvent,
        restoreEvent: store.listEvents(second.path)[0],
      };
    });

    expect(result.restored).toMatchObject({
      revision: 3,
      dirty: true,
      restoredFromSha: null,
      restoredFromEventId: result.firstEvent.id,
    });
    expect(result.restored.workingStory.cast[0].identity).toBe(
      "第一版工作区快照"
    );
    expect(result.restoreEvent).toMatchObject({
      kind: "restore",
      restoredFromSha: null,
      metadata: {
        targetEventId: result.firstEvent.id,
        targetRevision: result.firstEvent.revision,
      },
      beforeStory: {
        cast: expect.arrayContaining([
          expect.objectContaining({ identity: "第二版工作区快照" }),
        ]),
      },
      afterStory: {
        cast: expect.arrayContaining([
          expect.objectContaining({ identity: "第一版工作区快照" }),
        ]),
      },
    });
  });

  it("pages through more than 500 events and restores the oldest snapshot", async () => {
    const result = await inStore(repository(), async (store) => {
      let workspace = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });

      for (let revision = 1; revision <= 501; revision += 1) {
        const changed = structuredClone(workspace.workingStory);
        changed.cast[0].identity = `第 ${revision} 版身份`;
        workspace = store.update({
          path: workspace.path,
          expectedRevision: workspace.revision,
          story: changed,
          actor: revision % 2 === 0 ? "user:tester" : "agent:chat-a",
          source: revision % 2 === 0 ? "relationship-panel" : "agent",
          summary: `生成第 ${revision} 版快照`,
        });
      }

      const events = [];
      let beforeId: number | undefined;
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = store.listEvents(workspace.path, 100, beforeId);
        events.push(...page);
        if (page.length < 100) break;
        beforeId = page.at(-1)!.id;
      }

      const oldest = events.at(-1)!;
      const restored = store.restoreEventSnapshot({
        path: workspace.path,
        eventId: oldest.id,
        expectedRevision: workspace.revision,
        actor: "user:tester",
        source: "ui-event-restore",
      });
      return { events, oldest, restored };
    });

    expect(new Set(result.events.map((event) => event.id)).size).toBe(502);
    expect(result.events).toHaveLength(502);
    expect(result.oldest).toMatchObject({ kind: "initialize", revision: 0 });
    expect(result.restored).toMatchObject({
      revision: 502,
      restoredFromEventId: result.oldest.id,
    });
    expect(result.restored.workingStory.cast[0].identity).toBe("刑警");
  });

  it("lists lightweight event summaries without selecting snapshot payloads", async () => {
    const result = await inStore(repository(), async (store, storage) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(initialized.workingStory);
      changed.cast[0].identity = "轻量摘要测试";
      const updated = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: changed,
        actor: "agent:chat-a",
        source: "agent",
        summary: "生成轻量摘要",
      });

      const exec = vi.spyOn(storage.sql, "exec");
      const summaries = store.listEventSummaries(updated.path, 1);
      const query = String(
        exec.mock.calls.find(([sql]) => String(sql).includes("has_snapshot"))?.[0]
      );
      return { summaries, query };
    });

    expect(result.query).not.toContain("before_story_json");
    expect(result.query).toContain(
      "CASE WHEN after_story_json IS NOT NULL THEN 1 ELSE 0 END AS has_snapshot"
    );
    expect(result.query).not.toContain("after_story_json,");
    expect(result.summaries[0]).toMatchObject({
      revision: 1,
      summary: "生成轻量摘要",
      hasSnapshot: true,
      diffSummary: { added: 0, removed: 0, modified: 1, total: 1 },
    });
    expect(result.summaries[0]).not.toHaveProperty("beforeStory");
    expect(result.summaries[0]).not.toHaveProperty("afterStory");
  });

  it("represents a missing repository file as a reviewable added working copy", async () => {
    const commitFile = vi.fn<StoryRepositoryClient["commitFile"]>(async (input) => ({
      sha: "first-story-commit",
      treeSha: "first-story-tree",
      message: input.message,
    }));
    const repo = repository({
      commitFile,
      getContent: vi.fn(async () => {
        throw new GitHubApiError(404, "GET", "/contents/story.json", "Not Found");
      }),
    });

    const result = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        initialStory: story(),
        actor: "system:tester",
        source: "initialize",
      });
      const diff = store.getDiff(initialized.path);
      const committed = await store.confirmCommit({
        path: initialized.path,
        expectedRevision: initialized.revision,
        message: "初始化默认剧本",
        actor: "user:tester",
        source: "diff-confirmation",
      });
      return { initialized, diff, committed };
    });

    expect(result.initialized).toMatchObject({ baseFileExists: false, dirty: true });
    expect(result.diff).toMatchObject({
      fileStatus: "added",
      business: { summary: { added: 5, total: 5 } },
    });
    expect(result.committed.workspace).toMatchObject({
      baseFileExists: true,
      baseCommitSha: "first-story-commit",
      dirty: false,
    });
    expect(commitFile).toHaveBeenCalledOnce();
  });

  it("reconciles a commit when GitHub advanced the ref but the response was lost", async () => {
    let remoteHead = "head-a";
    let committedStory = story();
    const repo = repository({
      getRef: vi.fn(async (branch: string) => ({
        ref: `refs/heads/${branch}`,
        sha: remoteHead,
      })),
      getContent: vi.fn(async (path: string, ref: string) => ({
        path,
        sha: `blob-${ref}`,
        content: serializeMysteryStory(ref === "commit-b" ? committedStory : story()),
      })),
      commitFile: vi.fn(async (input) => {
        committedStory = JSON.parse(input.content) as MysteryStoryDsl;
        remoteHead = "commit-b";
        throw new Error("网络在 ref 更新后断开");
      }),
      getCommit: vi.fn(async (sha: string) => ({
        sha,
        treeSha: "tree-b",
        message: "补充线索",
      })),
    });

    const result = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(initialized.workingStory);
      changed.cast[0].identity = "恢复后的刑警";
      const updated = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: changed,
        actor: "user:tester",
        source: "relationship-panel",
        summary: "补充线索",
      });
      const committed = await store.confirmCommit({
        path: updated.path,
        expectedRevision: updated.revision,
        message: "补充线索",
        actor: "user:tester",
        source: "ui-confirmation",
      });
      return { committed, events: store.listEvents(updated.path) };
    });

    expect(result.committed.workspace).toMatchObject({
      baseCommitSha: "commit-b",
      dirty: false,
      remoteHeadSha: null,
    });
    expect(result.committed.commit).toMatchObject({ sha: "commit-b" });
    expect(result.events[0]).toMatchObject({
      kind: "commit",
      metadata: { recovered: true },
    });
  });

  it("recovers a persisted commit nonce after the Store process restarts", async () => {
    let githubAvailable = true;
    let remoteHead = "head-a";
    let committedStory = story();
    const repo = repository({
      getRef: vi.fn(async (branch: string) => {
        if (!githubAvailable) throw new Error("GitHub 暂时不可用");
        return { ref: `refs/heads/${branch}`, sha: remoteHead };
      }),
      getContent: vi.fn(async (path: string, ref: string) => ({
        path,
        sha: `blob-${ref}`,
        content: serializeMysteryStory(ref === "commit-b" ? committedStory : story()),
      })),
      commitFile: vi.fn(async (input) => {
        committedStory = JSON.parse(input.content) as MysteryStoryDsl;
        remoteHead = "commit-b";
        githubAvailable = false;
        throw new Error("提交响应丢失");
      }),
      getCommit: vi.fn(async (sha: string) => ({
        sha,
        treeSha: "tree-b",
        message: "重启后恢复的提交",
      })),
    });

    const result = await inStore(repo, async (store, storage) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(initialized.workingStory);
      changed.cast[0].identity = "重启后仍可恢复";
      const updated = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: changed,
        actor: "user:tester",
        source: "relationship-panel",
      });

      await expect(
        store.confirmCommit({
          path: updated.path,
          expectedRevision: updated.revision,
          message: "重启后恢复的提交",
          actor: "user:tester",
          source: "ui-confirmation",
        })
      ).rejects.toThrow("提交响应丢失");

      githubAvailable = true;
      const restarted = new StoryWorkspaceStore(
        storage,
        repo,
        () => 1_800_000_001_000
      );
      const recovered = await restarted.initialize({
        path: updated.path,
        branch: "drafts/tester",
        actor: "system:tester",
        source: "initialize",
      });
      return { recovered, events: restarted.listEvents(updated.path) };
    });

    expect(result.recovered).toMatchObject({
      baseCommitSha: "commit-b",
      dirty: false,
      revision: 2,
    });
    expect(result.events[0]).toMatchObject({
      kind: "commit",
      actor: "user:tester",
      summary: "重启后恢复的提交",
      metadata: { recovered: true, commitSha: "commit-b" },
    });
  });

  it("clears an ambiguous nonce and safely syncs when the remote commit is different", async () => {
    let remoteHead = "head-a";
    const remoteStory = story();
    remoteStory.cast[1].identity = "远端更新的经营者";
    const repo = repository({
      getRef: vi.fn(async (branch: string) => ({
        ref: `refs/heads/${branch}`,
        sha: remoteHead,
      })),
      getContent: vi.fn(async (path: string, ref: string) => ({
        path,
        sha: `blob-${ref}`,
        content: serializeMysteryStory(ref === "head-remote" ? remoteStory : story()),
      })),
      commitFile: vi.fn(async () => {
        remoteHead = "head-remote";
        throw new Error("远端分支被其他提交推进");
      }),
    });

    const result = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(initialized.workingStory);
      changed.cast[0].identity = "本地未提交身份";
      const updated = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: changed,
        actor: "user:tester",
        source: "relationship-panel",
      });
      const error = await store
        .confirmCommit({
          path: updated.path,
          expectedRevision: updated.revision,
          message: "尝试提交本地身份",
          actor: "user:tester",
          source: "ui-confirmation",
        })
        .catch((caught) => caught);
      const afterConflict = store.read(updated.path);
      const synced = await store.syncFromRemote({
        path: updated.path,
        expectedRevision: updated.revision,
        actor: "user:tester",
        source: "ui-sync",
      });
      return { error, afterConflict, synced };
    });

    expect(result.error).toBeInstanceOf(GitHubConflictError);
    expect(result.afterConflict).toMatchObject({
      revision: 1,
      dirty: true,
      remoteHeadSha: "head-remote",
    });
    expect(result.synced).toMatchObject({
      baseCommitSha: "head-remote",
      revision: 2,
      dirty: true,
      remoteHeadSha: null,
    });
    expect(result.synced.workingStory.cast[0].identity).toBe("本地未提交身份");
    expect(result.synced.workingStory.cast[1].identity).toBe("远端更新的经营者");
  });

  it("rebases a dirty working copy onto a remote branch update without losing it", async () => {
    let remoteHead = "head-a";
    const remoteStory = story();
    remoteStory.cast[1].identity = "远端仓库经营者";
    const repo = repository({
      getRef: vi.fn(async (branch: string) => ({
        ref: `refs/heads/${branch}`,
        sha: remoteHead,
      })),
      getContent: vi.fn(async (path: string, ref: string) => ({
        path,
        sha: `blob-${ref}`,
        content: serializeMysteryStory(ref === "head-remote" ? remoteStory : story()),
      })),
    });

    const result = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const localStory = structuredClone(initialized.workingStory);
      localStory.cast[0].identity = "本地未提交身份";
      const local = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: localStory,
        actor: "agent:chat-a",
        source: "agent",
        summary: "Agent 本地修改",
      });
      remoteHead = "head-remote";
      const synced = await store.syncFromRemote({
        path: local.path,
        expectedRevision: local.revision,
        actor: "user:tester",
        source: "ui-sync",
      });
      return { synced, events: store.listEvents(local.path) };
    });

    expect(result.synced).toMatchObject({
      baseCommitSha: "head-remote",
      dirty: true,
      remoteHeadSha: null,
    });
    expect(result.synced.baseStory.cast[1].identity).toBe("远端仓库经营者");
    expect(result.synced.workingStory.cast[0].identity).toBe("本地未提交身份");
    expect(result.synced.workingStory.cast[1].identity).toBe("远端仓库经营者");
    expect(result.events[0]).toMatchObject({
      kind: "sync",
      baseCommitSha: "head-remote",
      beforeStory: {
        cast: expect.arrayContaining([
          expect.objectContaining({ identity: "本地未提交身份" }),
          expect.objectContaining({ identity: "仓库老板" }),
        ]),
      },
      afterStory: {
        cast: expect.arrayContaining([
          expect.objectContaining({ identity: "本地未提交身份" }),
          expect.objectContaining({ identity: "远端仓库经营者" }),
        ]),
      },
      metadata: {
        previousBaseSha: "head-a",
        remoteHeadSha: "head-remote",
        previousBaseStory: expect.objectContaining({
          cast: expect.any(Array),
        }),
        remoteBaseStory: expect.objectContaining({
          cast: expect.any(Array),
        }),
      },
    });
  });

  it("leaves the workspace untouched when local and remote edit the same field", async () => {
    const remoteStory = story();
    remoteStory.cast[0].identity = "远端身份";
    const repo = repository({
      getRef: vi.fn(async (branch: string) => ({
        ref: `refs/heads/${branch}`,
        sha: "head-remote",
      })),
      getContent: vi.fn(async (path: string, ref: string) => ({
        path,
        sha: `blob-${ref}`,
        content: serializeMysteryStory(ref === "head-remote" ? remoteStory : story()),
      })),
    });

    const result = await inStore(repo, async (store) => {
      const initialized = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const localStory = structuredClone(initialized.workingStory);
      localStory.cast[0].identity = "本地身份";
      const local = store.update({
        path: initialized.path,
        expectedRevision: initialized.revision,
        story: localStory,
        actor: "user:tester",
        source: "relationship-panel",
      });
      const error = await store
        .syncFromRemote({
          path: local.path,
          expectedRevision: local.revision,
          actor: "user:tester",
          source: "ui-sync",
        })
        .catch((caught) => caught);
      return { error, workspace: store.read(local.path) };
    });

    expect(result.error).toBeInstanceOf(StoryWorkspaceRebaseConflictError);
    expect(result.error).toMatchObject({
      previousBaseSha: "head-a",
      remoteHeadSha: "head-remote",
      paths: ["/cast/0/identity"],
    });
    expect(result.workspace).toMatchObject({
      baseCommitSha: "head-a",
      revision: 1,
      dirty: true,
      remoteHeadSha: null,
    });
    expect(result.workspace.workingStory.cast[0].identity).toBe("本地身份");
  });

  it("does not open a pull request while unconfirmed changes remain", async () => {
    const createPullRequest = vi.fn<StoryRepositoryClient["createPullRequest"]>();
    const repo = repository({ createPullRequest });
    const error = await inStore(repo, async (store) => {
      const workspace = await store.initialize({
        path: "stories/default/story.json",
        branch: "drafts/tester",
        actor: "user:tester",
        source: "panel",
      });
      const changed = structuredClone(workspace.workingStory);
      changed.cast[0].identity = "重案组刑警";
      store.update({
        path: workspace.path,
        expectedRevision: workspace.revision,
        story: changed,
        actor: "user:tester",
        source: "panel",
      });
      return store.createPullRequest({ path: workspace.path, title: "更新剧本" }).catch(
        (caught) => caught
      );
    });

    expect(String(error)).toContain("未确认修改");
    expect(createPullRequest).not.toHaveBeenCalled();
  });
});
