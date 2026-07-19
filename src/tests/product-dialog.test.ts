import { describe, expect, it } from "vitest";
import {
  normalizedRename,
  productDialogActionState
} from "../components/product-dialog-model";

describe("product dialog behavior", () => {
  it("normalizes a changed chat name before confirmation", () => {
    expect(normalizedRename("旧标题", "  新标题  ")).toBe("新标题");
  });

  it("keeps rename confirmation disabled for empty or unchanged input", () => {
    expect(normalizedRename("原名", "   ")).toBeNull();
    expect(normalizedRename("原名", "原名")).toBeNull();
    expect(normalizedRename("原名", "  原名  ")).toBeNull();
  });

  it("locks cancel and confirm actions while an async operation is busy", () => {
    expect(productDialogActionState(true)).toEqual({
      cancelDisabled: true,
      confirmDisabled: true
    });
    expect(productDialogActionState(false, true)).toEqual({
      cancelDisabled: false,
      confirmDisabled: true
    });
  });
});
