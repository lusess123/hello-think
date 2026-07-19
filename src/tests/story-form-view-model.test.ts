import { describe, expect, it } from "vitest";
import {
  buildStoryFormItems,
  countStoryDiff,
  filterStoryFormItems
} from "../story/form-view-model";
import type { StoryWorkspace } from "../story/types";

function workspace(): StoryWorkspace {
  return {
    branch: "drafts/tester",
    baseCommitSha: "abc1234",
    revision: 5,
    dirty: true,
    story: {
      cast: [
        { key: "detective", name: "林川", identity: "刑警" },
        { key: "owner", name: "周明", identity: "仓库老板" }
      ],
      bonds: [
        { source: "detective", relation: "friend", target: "owner" }
      ],
      storyline: {
        opening: "arrival",
        timeline: [
          {
            key: "arrival",
            at: "21:30",
            actor: "detective",
            event: "抵达仓库",
            next: "search"
          },
          {
            key: "search",
            at: "21:40",
            actors: ["detective", "owner"],
            event: "搜查仓库",
            end: true
          }
        ]
      }
    },
    diff: {
      items: [
        {
          action: "modified",
          category: "timeline",
          label: "search",
          changedFields: ["event"]
        },
        {
          action: "removed",
          category: "cast",
          label: "witness",
          changedFields: ["name", "identity"],
          before: { key: "witness", name: "苏雨", identity: "目击者" }
        },
        {
          type: "added",
          scope: "story",
          label: "storyline",
          changedFields: ["opening"]
        }
      ],
      jsonLines: []
    }
  };
}

describe("story form view model", () => {
  it("builds one ordered list and keeps removed business snapshots visible", () => {
    const items = buildStoryFormItems(workspace());

    expect(items.map((item) => item.kind)).toEqual([
      "opening",
      "person",
      "person",
      "person",
      "bond",
      "timeline",
      "timeline"
    ]);
    expect(items[0]).toEqual(
      expect.objectContaining({
        id: "opening:storyline",
        marker: expect.objectContaining({ action: "added" })
      })
    );
    expect(items.find((item) => item.id === "person:witness")).toEqual(
      expect.objectContaining({
        title: "苏雨",
        removed: true,
        marker: expect.objectContaining({ action: "removed" })
      })
    );
    expect(items.find((item) => item.id === "bond:detective→owner")?.title).toBe(
      "林川 → 周明"
    );
  });

  it("filters by entity kind and every visible summary field", () => {
    const items = buildStoryFormItems(workspace());

    expect(filterStoryFormItems(items, "timeline", "周明").map((item) => item.id)).toEqual([
      "timeline:search"
    ]);
    expect(filterStoryFormItems(items, "all", "目击者").map((item) => item.id)).toEqual([
      "person:witness"
    ]);
    expect(filterStoryFormItems(items, "bond", "商业伙伴")).toEqual([]);
  });

  it("counts both current and legacy diff action fields", () => {
    expect(countStoryDiff(workspace().diff.items)).toEqual({
      added: 1,
      modified: 1,
      removed: 1,
      total: 3
    });
  });
});
