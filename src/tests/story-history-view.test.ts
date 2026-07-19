import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/kumo", () => ({
  Badge: () => null,
  Button: () => null,
}));
vi.mock("@phosphor-icons/react", () => ({
  ArrowClockwiseIcon: () => null,
  ClockCounterClockwiseIcon: () => null,
  GitCommitIcon: () => null,
  GitPullRequestIcon: () => null,
  SpinnerGapIcon: () => null,
}));

import {
  eventDiffTotal,
  historySnapshotEntries,
} from "../story/history-view";
import type {
  MysteryStoryDsl,
  StoryLayout,
  StoryWorkspaceEvent,
} from "../story/types";

describe("story history layout presentation", () => {
  it("counts layout changes in the event change summary", () => {
    const event = {
      diff: {
        business: { summary: { total: 2 } },
        layout: [
          {
            id: "person:detective",
            before: { x: 100, y: 100 },
            after: { x: 180, y: 120 },
          },
        ],
      },
    } as StoryWorkspaceEvent;

    expect(eventDiffTotal(event)).toBe(3);
  });

  it("includes story and layout sidecar snapshots in history preview data", () => {
    const story: MysteryStoryDsl = {
      cast: [],
      bonds: [],
      storyline: { opening: "start", timeline: [] },
    };
    const layout: StoryLayout = {
      version: 1,
      nodes: { opening: { x: 320, y: 480 } },
    };

    const entries = historySnapshotEntries(story, layout);

    expect(entries.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "story", label: "story.json" },
      { id: "layout", label: "story.layout.json · 1 个定位" },
    ]);
    expect(entries[1]?.value).toEqual(layout);
  });
});
