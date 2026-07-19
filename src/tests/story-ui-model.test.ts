import { describe, expect, it } from "vitest";
import {
  applyStoryEntity,
  storyEntityForTarget,
  storyTargetExists
} from "../story/story-operations";
import type {
  MysteryStoryDsl,
  StoryBond,
  StoryWorkspace
} from "../story/types";
import {
  adoptRemoteDraft,
  createLocalDraft,
  editLocalDraft,
  findStoryBondIndex,
  keepLocalDraft,
  mergeStoryEvents,
  receiveRemoteDraft,
  storyBondKey,
  storyEditorTargetId
} from "../story/ui-model";

describe("story event history pagination", () => {
  it("appends older pages without duplicating overlapping events", () => {
    const event = (id: number) => ({
      id,
      path: "stories/default/story.json",
      revision: id,
      kind: "update" as const,
      actor: "user:tester",
      source: "panel",
      createdAt: id
    });

    expect(
      mergeStoryEvents([event(5), event(4), event(3)], [event(3), event(2), event(1)])
        .map((item) => item.id)
    ).toEqual([5, 4, 3, 2, 1]);
  });
});

describe("story UI local draft reconciliation", () => {
  it("follows remote revisions while the local editor is clean", () => {
    const state = createLocalDraft("old", 3);
    expect(receiveRemoteDraft(state, "new", 4)).toEqual({
      value: "new",
      dirty: false,
      seenRevision: 4
    });
  });

  it("keeps unsaved input and exposes an explicit remote conflict", () => {
    const dirty = editLocalDraft(createLocalDraft("old", 3), "my draft");
    expect(receiveRemoteDraft(dirty, "agent change", 4)).toEqual({
      value: "my draft",
      dirty: true,
      seenRevision: 3,
      conflictRevision: 4
    });
    expect(keepLocalDraft(receiveRemoteDraft(dirty, "agent change", 4), 4)).toEqual({
      value: "my draft",
      dirty: true,
      seenRevision: 4,
      conflictRevision: undefined
    });
    expect(adoptRemoteDraft("agent change", 4)).toEqual({
      value: "agent change",
      dirty: false,
      seenRevision: 4
    });
  });
});

describe("stable story bond identity", () => {
  const bonds: StoryBond[] = [
    { source: "a", relation: "friend", target: "b" },
    { source: "c", relation: "rival", target: "d" },
    { source: "a", relation: "rival", target: "b" }
  ];

  it("uses endpoint occurrence instead of the array index", () => {
    expect(storyBondKey(bonds, 0)).toBe("a→b");
    expect(storyBondKey(bonds, 1)).toBe("c→d");
    expect(storyBondKey(bonds, 2)).toBe("a→b#2");
  });

  it("survives unrelated reorder operations", () => {
    const reordered = [bonds[1], bonds[0], bonds[2]];
    expect(findStoryBondIndex(reordered, "a→b")).toBe(1);
    expect(findStoryBondIndex(reordered, "a→b#2")).toBe(2);
  });
});

describe("story design editor operations", () => {
  const story: MysteryStoryDsl = {
    cast: [
      { key: "detective", name: "侦探", identity: "调查者" },
      { key: "owner", name: "店主", identity: "目击者" }
    ],
    bonds: [
      { source: "detective", relation: "friend", target: "owner" }
    ],
    storyline: {
      opening: "arrival",
      timeline: [
        {
          key: "arrival",
          at: "09:00",
          actor: "detective",
          event: "抵达现场",
          next: "search"
        },
        {
          key: "search",
          at: "09:10",
          actor: "detective",
          event: "搜索现场",
          end: true
        }
      ]
    }
  };

  it("edits storyline.opening through the same target vocabulary", () => {
    expect(storyEditorTargetId({ kind: "opening" })).toBe("opening:storyline");
    const next = applyStoryEntity(story, { kind: "opening" }, { opening: "search" });
    expect(next.storyline.opening).toBe("search");
    expect(() =>
      applyStoryEntity(story, { kind: "opening" }, { opening: "missing" })
    ).toThrow("开场节点不存在");
  });

  it("makes restoring a removed design entity an explicit re-add operation", () => {
    const removed = { key: "suspect", name: "嫌疑人", identity: "失踪顾客" };
    const workspace: StoryWorkspace = {
      branch: "drafts/tester",
      baseCommitSha: "abc1234",
      revision: 4,
      dirty: true,
      story,
      diff: {
        items: [
          {
            action: "removed",
            category: "cast",
            label: removed.key,
            before: removed,
            changedFields: ["key", "name", "identity"]
          }
        ],
        jsonLines: []
      }
    };
    const target = { kind: "person", key: removed.key } as const;

    expect(storyTargetExists(story, target)).toBe(false);
    expect(storyEntityForTarget(workspace, target)).toEqual(removed);
    expect(applyStoryEntity(story, target, removed).cast).toContainEqual(removed);
  });
});
