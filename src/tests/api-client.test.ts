import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  apiUrl,
  fetchAgentConnectionQuery
} from "../api-client";

describe("browser API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves API paths and legacy relative document URLs", () => {
    const origin = "https://dsl-api.zyking.xyz";

    expect(apiUrl("/chat/story", origin)).toBe(
      "https://dsl-api.zyking.xyz/chat/story"
    );
    expect(apiUrl("chat/documents/123/content", origin)).toBe(
      "https://dsl-api.zyking.xyz/chat/documents/123/content"
    );
  });

  it("always includes the API-host credential", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/auth/logout", { method: "POST", credentials: "omit" });

    expect(fetchMock).toHaveBeenCalledWith(
      apiUrl("/auth/logout"),
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
  });

  it("obtains a short-lived WebSocket query token over credentialed HTTP", async () => {
    const fetchMock = vi.fn(async () => Response.json({ token: "signed-ticket" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAgentConnectionQuery()).resolves.toEqual({
      ws_token: "signed-ticket"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      apiUrl("/auth/ws-token"),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" }
      })
    );
  });

  it("rejects a missing WebSocket token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 }))
    );

    await expect(fetchAgentConnectionQuery()).rejects.toThrow(
      "Failed to obtain WebSocket token (HTTP 401)"
    );
  });
});
