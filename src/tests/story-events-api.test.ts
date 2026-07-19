import { describe, expect, it, vi } from "vitest";
import { AssistantDirectory } from "../../agents/assistant/agent";

describe("story event history route", () => {
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
      afterStory: {},
      diff: {
        business: { summary: { added: 0, removed: 0, modified: 1, total: 1 } }
      }
    }));
    const listEvents = vi.fn(
      (_path: string, limit: number, beforeId?: number) =>
        allEvents
          .filter((event) => beforeId === undefined || event.id < beforeId)
          .slice(0, limit)
    );
    const directory = Object.create(AssistantDirectory.prototype) as AssistantDirectory;
    Object.defineProperties(directory, {
      ensureStoryWorkspace: {
        value: vi.fn(async () => ({
          branch: "drafts/local",
          baseCommitSha: "head-a",
          revision: 5,
          dirty: true,
          restoredFromSha: null,
          restoredFromEventId: null
        }))
      },
      getStoryStore: {
        value: () => ({ listEvents, listVersions: vi.fn(async () => []) })
      },
      storyPath: { value: "stories/default/story.json" }
    });

    const history = await directory.getStoryHistory(2, 5);

    expect(history.revisions.map((revision) => revision.id)).toEqual([4, 3]);
    expect(history.nextBeforeId).toBe(3);
  });
});
