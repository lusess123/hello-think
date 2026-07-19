import { describe, expect, it } from "vitest";
import {
  createJsonLineDiff,
  createStoryBusinessDiff,
} from "../../agents/assistant/story/diff";
import {
  MysteryStoryDslSchema,
  serializeMysteryStory,
  type MysteryStoryDsl,
} from "../../agents/assistant/story/schema";

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
        {
          key: "arrival",
          at: "21:30",
          actor: "detective",
          event: "抵达仓库",
          next: "search",
        },
        {
          key: "search",
          at: "21:40",
          actors: ["detective", "owner"],
          event: "搜查仓库",
          end: true,
        },
      ],
    },
  };
}

describe("MysteryStoryDslSchema", () => {
  it("accepts the agreed mystery story shape", () => {
    expect(MysteryStoryDslSchema.parse(story())).toEqual(story());
  });

  it("rejects missing people and invalid timeline exits with useful paths", () => {
    const invalid = story();
    invalid.bonds[0].target = "missing-person";
    invalid.storyline.timeline[0].end = true;

    const result = MysteryStoryDslSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("bonds.0");
    expect(result.error.issues.some((issue) => issue.message.includes("只能使用"))).toBe(true);
  });
});

describe("story diff", () => {
  it("describes people, relationship and timeline changes by business identity", () => {
    const before = story();
    const after = structuredClone(before);
    after.cast.push({ key: "witness", name: "苏雨", identity: "目击者" });
    after.bonds[0].relation = "business_partner";
    after.storyline.timeline[1].event = "发现隐藏房间";

    const diff = createStoryBusinessDiff(before, after);
    expect(diff.cast).toEqual([
      expect.objectContaining({ kind: "added", key: "witness" }),
    ]);
    expect(diff.bonds).toEqual([
      expect.objectContaining({
        kind: "modified",
        key: "detective→owner",
        changedFields: ["relation"],
      }),
    ]);
    expect(diff.timeline).toEqual([
      expect.objectContaining({
        kind: "modified",
        key: "search",
        changedFields: ["event"],
      }),
    ]);
    expect(diff.summary).toEqual({ added: 1, removed: 0, modified: 2, total: 3 });
  });

  it("produces numbered JSON lines for a visual diff", () => {
    const before = story();
    const after = structuredClone(before);
    after.bonds[0].relation = "rival";
    const lines = createJsonLineDiff(
      serializeMysteryStory(before),
      serializeMysteryStory(after)
    );

    expect(lines).toContainEqual(
      expect.objectContaining({ kind: "removed", value: expect.stringContaining('"friend"') })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ kind: "added", value: expect.stringContaining('"rival"') })
    );
    expect(lines.filter((line) => line.kind === "context").length).toBeGreaterThan(1);
  });

  it("reports an opening-node change as a business-level story diff", () => {
    const before = story();
    const after = structuredClone(before);
    after.storyline.opening = "search";

    const diff = createStoryBusinessDiff(before, after);
    expect(diff.story).toEqual([
      expect.objectContaining({
        kind: "modified",
        key: "storyline",
        changedFields: ["opening"],
      }),
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, total: 1 });
  });
});
