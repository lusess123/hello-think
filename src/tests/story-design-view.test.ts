import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/kumo", () => ({
  Badge: () => null,
  Button: () => null,
}));
vi.mock("@phosphor-icons/react", () => ({
  ArrowsOutIcon: () => null,
  GitDiffIcon: () => null,
  MinusIcon: () => null,
  PlusIcon: () => null,
  TreeStructureIcon: () => null,
  UsersThreeIcon: () => null,
}));

import {
  canvasNodeDiffMarkers,
  canvasViewportFromMeasurements,
  findCanvasNodeBox,
  mergeDraggedNodeLayout,
} from "../story/design-view";

describe("story design layout interactions", () => {
  it("merges the dragged point into the latest layout without overwriting other nodes", () => {
    const latestLayout = {
      version: 1 as const,
      nodes: {
        opening: { x: 100, y: 420 },
        "person:lin": { x: 360, y: 180 },
      },
    };

    expect(
      mergeDraggedNodeLayout(
        latestLayout,
        "person:lin",
        { x: 520, y: 210 },
        new Set(["opening", "person:lin"]),
      ),
    ).toEqual({
      version: 1,
      nodes: {
        opening: { x: 100, y: 420 },
        "person:lin": { x: 520, y: 210 },
      },
    });
  });

  it("cancels a drag when the node no longer exists", () => {
    expect(
      mergeDraggedNodeLayout(
        {
          version: 1,
          nodes: { "person:removed": { x: 360, y: 180 } },
        },
        "person:removed",
        { x: 520, y: 210 },
        new Set(["opening"]),
      ),
    ).toBeNull();
  });

  it("resolves flow targets from top-level and parallel node maps", () => {
    const topLevel = { x: 80, y: 520, width: 190, height: 104 };
    const parallel = { x: 355, y: 1165, width: 170, height: 31 };
    const layout = {
      nodes: new Map([["chapter", topLevel]]),
      parallelEvents: new Map([["audio_analysis", parallel]]),
    };

    expect(findCanvasNodeBox(layout, "chapter")).toBe(topLevel);
    expect(findCanvasNodeBox(layout, "audio_analysis")).toBe(parallel);
  });

  it("calculates viewport coordinates with the zoom being applied", () => {
    expect(
      canvasViewportFromMeasurements(
        {
          scrollLeft: 200,
          scrollTop: 120,
          clientWidth: 800,
          clientHeight: 600,
        },
        2,
      ),
    ).toEqual({ x: 100, y: 60, width: 400, height: 300 });
  });

  it("keeps business and position markers when the same node changed in both ways", () => {
    const businessMarker = {
      action: "modified" as const,
      fields: ["name"],
      item: {
        action: "modified" as const,
        category: "cast",
        label: "detective",
      },
    };

    expect(canvasNodeDiffMarkers(businessMarker, true)).toEqual([
      businessMarker,
      expect.objectContaining({
        action: "modified",
        fields: ["位置"],
      }),
    ]);
  });
});
