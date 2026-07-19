import { describe, expect, it } from "vitest";
import { getMobileSidebarAccessibility } from "../components/mobile-sidebar-model";

describe("mobile sidebar accessibility", () => {
  it("removes a closed mobile sidebar from focus and the accessibility tree", () => {
    expect(getMobileSidebarAccessibility(false, false)).toEqual({
      inert: true,
      ariaHidden: true
    });
  });

  it("keeps an open mobile sidebar and the persistent desktop sidebar available", () => {
    expect(getMobileSidebarAccessibility(true, false)).toEqual({
      inert: false,
      ariaHidden: undefined
    });
    expect(getMobileSidebarAccessibility(false, true)).toEqual({
      inert: false,
      ariaHidden: undefined
    });
  });
});
