import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStoryEvents, updateStoryLayout } from "../story/api";

describe("story event history API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes the event cursor through and returns the next cursor", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ events: [], nextBeforeId: 42 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchStoryEvents({ limit: 80, beforeId: 123 });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/chat/story/events?limit=80&beforeId=123",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({ Accept: "application/json" })
      })
    );
    expect(page).toEqual({ events: [], nextBeforeId: 42 });
  });

  it("writes versioned layout through the dedicated endpoint", async () => {
    const workspace = { revision: 8 };
    const fetchMock = vi.fn(async () => Response.json({ workspace }));
    vi.stubGlobal("fetch", fetchMock);
    const layout = {
      version: 1 as const,
      nodes: { "timeline:arrival": { x: 320, y: 480 } }
    };

    const result = await updateStoryLayout({
      layout,
      expectedRevision: 7,
      source: "design-layout",
      summary: "自动布局"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/chat/story/layout",
      expect.objectContaining({
        credentials: "include",
        method: "PUT",
        body: JSON.stringify({
          layout,
          expectedRevision: 7,
          source: "design-layout",
          summary: "自动布局"
        })
      })
    );
    expect(result).toEqual(workspace);
  });
});
