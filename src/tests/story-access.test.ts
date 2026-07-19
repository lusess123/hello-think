import { describe, expect, it } from "vitest";
import { isStoryUserAllowed, storyDirectoryName } from "../access-control";

const user = {
  id: 12345,
  login: "StoryEditor",
  name: "Story Editor",
  avatarUrl: "",
};

describe("story access control", () => {
  it("fails closed and accepts only a stable GitHub ID", () => {
    expect(isStoryUserAllowed(user, "")).toBe(false);
    expect(isStoryUserAllowed(user, "storyeditor")).toBe(false);
    expect(isStoryUserAllowed(user, "999, 12345")).toBe(true);
    expect(isStoryUserAllowed(user, "someone-else")).toBe(false);
  });

  it("uses a stable GitHub ID for the production Durable Object", () => {
    expect(storyDirectoryName(user)).toBe("github-12345");
    expect(storyDirectoryName(user, true)).toBe("StoryEditor");
    expect(isStoryUserAllowed(user, undefined, true)).toBe(true);
  });
});
