import { describe, expect, it } from "vitest";
import { createStoryTreeLayout } from "../story/story-tree-layout";
import type { TimelineNode } from "../story/types";

function storyNode(
  key: string,
  exit: Pick<TimelineNode, "next" | "routes" | "end">,
  extra: Partial<TimelineNode> = {}
): TimelineNode {
  return {
    key,
    at: "09:00",
    event: key,
    ...exit,
    ...extra
  } as TimelineNode;
}

function positions(layout: ReturnType<typeof createStoryTreeLayout>) {
  return Object.fromEntries(
    [...layout.nodes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, box]) => [key, { x: box.x, y: box.y }])
  );
}

describe("top-down story tree layout", () => {
  const graph = [
    storyNode("root", { routes: { left: "left", right: "right" } }),
    storyNode("left", { next: "merge" }),
    storyNode("right", { next: "merge" }),
    storyNode("merge", { end: true })
  ];

  it("derives stable ranks and positions from topology instead of timeline order", () => {
    const ordered = createStoryTreeLayout(graph, "root");
    const shuffled = createStoryTreeLayout(
      [graph[3]!, graph[1]!, graph[0]!, graph[2]!],
      "root"
    );

    expect(Object.fromEntries(shuffled.ranks)).toEqual(
      Object.fromEntries(ordered.ranks)
    );
    expect(positions(shuffled)).toEqual(positions(ordered));
    expect(shuffled.ranks.get("root")).toBe(0);
  });

  it("places route targets side by side on the same layer", () => {
    const layout = createStoryTreeLayout(graph, "root");
    const left = layout.nodes.get("left")!;
    const right = layout.nodes.get("right")!;

    expect(layout.ranks.get("left")).toBe(1);
    expect(layout.ranks.get("right")).toBe(1);
    expect(left.y).toBe(right.y);
    expect(Math.abs(left.x - right.x)).toBeGreaterThanOrEqual(left.width);
  });

  it("places a merge below every predecessor", () => {
    const layout = createStoryTreeLayout(graph, "root");
    const mergeRank = layout.ranks.get("merge")!;

    expect(mergeRank).toBeGreaterThan(layout.ranks.get("left")!);
    expect(mergeRank).toBeGreaterThan(layout.ranks.get("right")!);
    expect(layout.nodes.get("merge")!.y).toBeGreaterThan(
      Math.max(
        layout.nodes.get("left")!.y + layout.nodes.get("left")!.height,
        layout.nodes.get("right")!.y + layout.nodes.get("right")!.height
      )
    );
  });

  it("degrades cycles and unreachable components deterministically without looping", () => {
    const nodes = [
      storyNode("root", { next: "loop-a" }),
      storyNode("loop-a", { next: "root" }),
      storyNode("orphan-a", { next: "orphan-b" }),
      storyNode("orphan-b", { next: "orphan-a" })
    ];
    const first = createStoryTreeLayout(nodes, "root");
    const second = createStoryTreeLayout([...nodes].reverse(), "root");

    expect(first.nodes.size).toBe(4);
    expect(first.ranks.get("root")).toBe(0);
    expect(first.ranks.get("loop-a")).toBe(0);
    expect(first.ranks.get("orphan-a")).toBeGreaterThan(0);
    expect(first.ranks.get("orphan-b")).toBe(first.ranks.get("orphan-a"));
    expect(positions(first)).toEqual(positions(second));
  });

  it("never overlaps nodes on a layer and grows the canvas for width and depth", () => {
    const wideGraph = [
      storyNode("root", {
        routes: {
          a: "branch-a",
          b: "branch-b",
          c: "branch-c",
          d: "branch-d"
        }
      }),
      storyNode("branch-a", { next: "deep" }),
      storyNode("branch-b", { end: true }),
      storyNode("branch-c", { end: true }),
      storyNode("branch-d", { end: true }, {
        event: undefined,
        parallel: [
          { key: "lane-a", actor: "actor", event: "lane a" },
          { key: "lane-b", actor: "actor", event: "lane b" }
        ]
      }),
      storyNode("deep", { next: "deeper" }),
      storyNode("deeper", { end: true })
    ];
    const layout = createStoryTreeLayout(wideGraph, "root");

    for (const layer of layout.layers) {
      const boxes = layer
        .map((key) => layout.nodes.get(key)!)
        .sort((left, right) => left.x - right.x);
      for (let index = 1; index < boxes.length; index += 1) {
        expect(boxes[index]!.x).toBeGreaterThanOrEqual(
          boxes[index - 1]!.x + boxes[index - 1]!.width
        );
      }
    }

    const maximumRight = Math.max(
      ...[...layout.nodes.values()].map((box) => box.x + box.width)
    );
    const maximumBottom = Math.max(
      ...[...layout.nodes.values()].map((box) => box.y + box.height)
    );
    expect(layout.width).toBeGreaterThan(maximumRight);
    expect(layout.height).toBeGreaterThan(maximumBottom);
    expect(layout.nodes.get("deeper")!.y).toBeGreaterThan(
      layout.nodes.get("deep")!.y
    );
  });
});
