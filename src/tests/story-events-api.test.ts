import { describe, expect, it, vi } from "vitest";
import { AssistantDirectory } from "../../agents/assistant/agent";

describe("story event history route", () => {
  it("updates layout through a revision-guarded dedicated route", async () => {
    const layout = {
      version: 1 as const,
      nodes: { opening: { x: 420, y: 360 } }
    };
    const updated = { revision: 4, layout };
    const updateLayout = vi.fn(() => updated);
    const directory = Object.create(AssistantDirectory.prototype) as AssistantDirectory;
    Object.defineProperties(directory, {
      ensureStoryWorkspace: { value: vi.fn(async () => ({ revision: 3 })) },
      getStoryStore: { value: () => ({ updateLayout }) },
      storyPath: { value: "stories/default/story.json" },
      storyOwnerLogin: { value: "tester" },
      storyWorkspaceView: { value: (workspace: unknown) => workspace },
      _broadcastStoryChange: { value: vi.fn() }
    });

    const response = await directory.onRequest(
      new Request("https://example.com/chat/story/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          layout,
          expectedRevision: 3,
          source: "design-layout",
          summary: "保存拖动位置"
        })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace: updated });
    expect(updateLayout).toHaveBeenCalledWith({
      path: "stories/default/story.json",
      expectedRevision: 3,
      layout,
      actor: "user:tester",
      source: "design-layout",
      summary: "保存拖动位置"
    });
  });

  it("returns an older event page with a continuation cursor", async () => {
    const allEvents = [5, 4, 3, 2, 1].map((id) => ({ id }));
    const listEvents = vi.fn(
      (_path: string, limit: number, beforeId?: number) =>
        allEvents
          .filter((event) => beforeId === undefined || event.id < beforeId)
          .slice(0, limit)
    );
    const directory = Object.create(AssistantDirectory.prototype) as AssistantDirectory;
    Object.defineProperties(directory, {
      ensureStoryWorkspace: { value: vi.fn(async () => ({})) },
      getStoryStore: { value: () => ({ listEvents }) },
      storyPath: { value: "stories/default/story.json" }
    });

    const response = await directory.onRequest(
      new Request("https://example.com/chat/story/events?limit=2&beforeId=5")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [{ id: 4 }, { id: 3 }],
      nextBeforeId: 3
    });
    expect(listEvents).toHaveBeenNthCalledWith(
      1,
      "stories/default/story.json",
      2,
      5
    );
  });

  it("exposes beforeId and nextBeforeId to the LLM history RPC", async () => {
    const allEvents = [5, 4, 3, 2, 1].map((id) => ({
      id,
      revision: id,
      kind: "update",
      summary: `revision ${id}`,
      actor: "agent:test",
      source: "agent",
      createdAt: id,
      baseCommitSha: "head-a",
      restoredFromSha: null,
      metadata: {},
      hasSnapshot: true,
      diffSummary: { added: 0, removed: 0, modified: 1, total: 1 }
    }));
    const listEventSummaries = vi.fn(
      (_path: string, limit: number, beforeId?: number) =>
        allEvents
          .filter((event) => beforeId === undefined || event.id < beforeId)
          .slice(0, limit)
    );
    const listVersions = vi.fn(async () => []);
    const directory = Object.create(AssistantDirectory.prototype) as AssistantDirectory;
    Object.defineProperties(directory, {
      ensureStoryWorkspace: {
        value: vi.fn(async () => ({
          path: "stories/default/story.json",
          branch: "drafts/local",
          baseCommitSha: "head-a",
          revision: 5,
          dirty: true,
          restoredFromSha: null,
          restoredFromEventId: null
        }))
      },
      getStoryStore: {
        value: () => ({ listEventSummaries, listVersions })
      },
      storyPath: { value: "stories/default/story.json" }
    });

    const history = await directory.getStoryHistory(2, 5);

    expect(history.revisions.map((revision) => revision.id)).toEqual([4, 3]);
    expect(history.revisions[0]).toMatchObject({
      hasSnapshot: true,
      diffSummary: { added: 0, removed: 0, modified: 1, total: 1 }
    });
    expect(history.nextBeforeId).toBe(3);
    expect(history.commits).toEqual([]);
    expect(listVersions).not.toHaveBeenCalled();

    await directory.getStoryHistory(2);
    expect(listVersions).toHaveBeenCalledWith("stories/default/story.json", {
      page: 1,
      perPage: 2
    });
  });
});
