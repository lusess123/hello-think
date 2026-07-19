import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StoryWorkspace } from "../story/types";

vi.mock("@cloudflare/kumo", () => ({
  Button: () => null
}));
vi.mock("@phosphor-icons/react", () => ({
  FlagIcon: () => null,
  FlowArrowIcon: () => null,
  GitDiffIcon: () => null,
  LinkIcon: () => null,
  MagnifyingGlassIcon: () => null,
  PlusIcon: () => null,
  UserIcon: () => null,
  WarningCircleIcon: () => null,
  XIcon: () => null
}));
vi.mock("../components/product-dialog", () => ({
  ProductConfirmDialog: () => null
}));

import { FormView } from "../story/form-view";
import {
  StoryEmpty,
  StorySectionHeader,
  STORY_INPUT_CLASS
} from "../story/story-ui";

describe("story text contrast", () => {
  it("uses readable tokens for shared input placeholders and supporting text", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(StorySectionHeader, {
          title: "结构化表单",
          meta: "2 人 · 1 条关系"
        }),
        createElement(StoryEmpty, { label: "当前类型下没有实体" })
      )
    );

    expect(STORY_INPUT_CLASS).toContain("placeholder:text-kumo-subtle");
    expect(STORY_INPUT_CLASS).not.toContain("placeholder:text-kumo-placeholder");
    expect(html).toContain("text-kumo-subtle");
    expect(html).not.toContain("text-kumo-inactive");
  });

  it("applies the readable shared placeholder token to Form search", () => {
    const html = renderToStaticMarkup(
      createElement(FormView, {
        workspace: emptyWorkspace(),
        disabled: false,
        onEdit: () => undefined
      })
    );

    expect(html).toContain('placeholder="搜索名称、标识、事件或字段"');
    expect(html).toContain("placeholder:text-kumo-subtle");
    expect(html).not.toContain("placeholder:text-kumo-placeholder");
  });
});

function emptyWorkspace(): StoryWorkspace {
  return {
    branch: "drafts/tester",
    baseCommitSha: "abc1234",
    revision: 1,
    dirty: false,
    story: {
      cast: [],
      bonds: [],
      storyline: {
        opening: "opening",
        timeline: []
      }
    },
    diff: {
      items: [],
      jsonLines: []
    }
  };
}
