import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  VirtualList,
  getVirtualListFollowOptions
} from "../components/virtual-list";
import type { VirtualListProps } from "../components/virtual-list";

describe("getVirtualListFollowOptions", () => {
  it("starts at the top and does not follow when disabled", () => {
    expect(getVirtualListFollowOptions(false)).toEqual({
      anchorTo: "start",
      followOnAppend: false,
      initialOffset: 0,
      scrollEndThreshold: 48
    });
  });

  it("starts at the bottom and follows new rows when enabled", () => {
    expect(getVirtualListFollowOptions(true, 80)).toEqual({
      anchorTo: "end",
      followOnAppend: "auto",
      initialOffset: Number.MAX_SAFE_INTEGER,
      scrollEndThreshold: 80
    });
  });

  it("normalizes invalid bottom thresholds", () => {
    expect(getVirtualListFollowOptions(true, -10).scrollEndThreshold).toBe(0);
    expect(getVirtualListFollowOptions(true, Number.NaN).scrollEndThreshold).toBe(
      48
    );
  });
});

describe("VirtualList", () => {
  it("renders an accessible empty state inside the scroll container", () => {
    const props: VirtualListProps<string> = {
      items: [],
      renderItem: (item) => item,
      getItemKey: (item) => item,
      estimateSize: () => 48,
      className: "scroll-region",
      emptyState: "No messages",
      "aria-label": "Messages"
    };

    const html = renderToStaticMarkup(
      createElement(VirtualList<string>, props)
    );

    expect(html).toContain('class="scroll-region"');
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-label="Messages"');
    expect(html).toContain('role="status"');
    expect(html).toContain("No messages");
  });

  it("applies a separate class to the virtual window", () => {
    const props: VirtualListProps<string> = {
      items: ["one"],
      renderItem: (item) => item,
      getItemKey: (item) => item,
      estimateSize: () => 48,
      windowClassName: "virtual-window"
    };

    const html = renderToStaticMarkup(
      createElement(VirtualList<string>, props)
    );

    expect(html).toContain('class="virtual-window"');
    expect(html).toContain("height:48px");
  });
});
