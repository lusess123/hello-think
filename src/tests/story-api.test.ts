import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStoryEvents } from "../story/api";

describe("story event history API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes the event cursor through and returns the next cursor", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ events: [], nextBeforeId: 42 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchStoryEvents({ limit: 80, beforeId: 123 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/chat/story/events?limit=80&beforeId=123",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" })
      })
    );
    expect(page).toEqual({ events: [], nextBeforeId: 42 });
  });
});
