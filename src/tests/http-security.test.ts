import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HttpBindings } from "../http/app";
import { httpApp } from "../http/app";
import type { ThinkAppContext } from "../http/chat-routing";
import { strictOriginGate } from "../http/origin-middleware";
import {
  canonicalApiOrigin,
  canonicalFrontendOrigin,
  isAllowedFrontendOrigin
} from "../http/origins";
import { createWebSocketToken } from "../http/ws-token";
import { handleWebSocketUpgrade } from "../server";
import { handleGitHubLogin } from "../auth";

const API_ORIGIN = "https://dsl-api.zyking.xyz";
const FRONTEND_ORIGIN = "https://dsl.zyking.xyz";
const WS_TOKEN_SECRET = "test-only-websocket-hmac-secret-32-bytes-long";

function productionEnv(overrides: Partial<HttpBindings> = {}): HttpBindings {
  return {
    API_ORIGIN,
    FRONTEND_ORIGIN,
    WS_TOKEN_SECRET,
    DEV_USER: "",
    STORY_ALLOWED_GITHUB_USERS: "11750878",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    ...overrides
  } as HttpBindings;
}

function localEnv(overrides: Partial<HttpBindings> = {}): HttpBindings {
  return productionEnv({
    API_ORIGIN: "",
    FRONTEND_ORIGIN: "",
    DEV_USER: "local",
    ...overrides
  });
}

describe("canonical origins", () => {
  it("accepts only the configured production API and frontend origins", () => {
    const request = new Request(`${API_ORIGIN}/auth/me`);
    const env = productionEnv();

    expect(canonicalApiOrigin(request, env)).toBe(API_ORIGIN);
    expect(canonicalFrontendOrigin(request, env)).toBe(FRONTEND_ORIGIN);
    expect(isAllowedFrontendOrigin(FRONTEND_ORIGIN, request, env)).toBe(true);
    expect(isAllowedFrontendOrigin("https://evil.zyking.xyz", request, env)).toBe(
      false
    );
    expect(() =>
      canonicalApiOrigin(
        new Request("https://hello-think.example.workers.dev/auth/me"),
        env
      )
    ).toThrow("API_ORIGIN");
  });

  it("keeps local development zero-config but limits origins to loopback HTTP", () => {
    const request = new Request("http://127.0.0.1:5173/auth/me");
    const env = localEnv();
    expect(canonicalApiOrigin(request, env)).toBe("http://127.0.0.1:5173");
    expect(
      isAllowedFrontendOrigin("http://localhost:5173", request, env)
    ).toBe(true);
    expect(isAllowedFrontendOrigin(FRONTEND_ORIGIN, request, env)).toBe(false);
  });
});

describe("Hono origin and CORS boundary", () => {
  it("answers an exact credentialed preflight", async () => {
    const response = await httpApp.request(
      `${API_ORIGIN}/auth/ws-token`,
      {
        method: "OPTIONS",
        headers: {
          Origin: FRONTEND_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-dsl-csrf"
        }
      },
      productionEnv()
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      FRONTEND_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  it("explicitly rejects unknown origins, methods, and headers", async () => {
    const requests: Array<Record<string, string>> = [
      {
        Origin: "https://evil.zyking.xyz",
        "Access-Control-Request-Method": "POST"
      },
      {
        Origin: FRONTEND_ORIGIN,
        "Access-Control-Request-Method": "PATCH"
      },
      {
        Origin: FRONTEND_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-untrusted"
      }
    ];

    for (const headers of requests) {
      const response = await httpApp.request(
        `${API_ORIGIN}/auth/ws-token`,
        { method: "OPTIONS", headers },
        productionEnv()
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it("rejects an unsafe request without Origin before it can mutate state", async () => {
    const response = await httpApp.request(
      `${API_ORIGIN}/auth/logout`,
      { method: "POST" },
      productionEnv()
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps exact CORS headers on an authenticated endpoint's 401", async () => {
    const response = await httpApp.request(
      `${API_ORIGIN}/auth/me`,
      { headers: { Origin: FRONTEND_ORIGIN } },
      productionEnv()
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      FRONTEND_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
  });

  it("issues a local DEV_USER token with exact credentialed CORS", async () => {
    const origin = "http://localhost:5173";
    const response = await httpApp.request(
      "http://127.0.0.1:5173/auth/ws-token",
      {
        method: "POST",
        headers: { Origin: origin, Accept: "application/json" }
      },
      localEnv()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
    await expect(response.json()).resolves.toMatchObject({
      token: expect.any(String)
    });
  });

  it("preserves the MCP callback GET navigation exception", async () => {
    const callbackApp = new Hono<{ Bindings: Env }>();
    callbackApp.use("*", strictOriginGate);
    callbackApp.get("/chat/mcp-callback", (c) => c.text("callback accepted"));

    const response = await callbackApp.request(
      `${API_ORIGIN}/chat/mcp-callback?code=provider-code`,
      { headers: { Origin: "https://oauth.provider.example" } },
      productionEnv()
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("callback accepted");
  });

  it("keeps explicit 404 and 405 responses", async () => {
    const notFound = await httpApp.request(
      `${API_ORIGIN}/missing`,
      undefined,
      productionEnv()
    );
    expect(notFound.status).toBe(404);

    const methodNotAllowed = await httpApp.request(
      `${API_ORIGIN}/auth/ws-token`,
      { method: "GET", headers: { Origin: FRONTEND_ORIGIN } },
      productionEnv()
    );
    expect(methodNotAllowed.status).toBe(405);
  });
});

describe("canonical GitHub OAuth entry", () => {
  it("uses the API callback and a host-only prefixed state cookie", () => {
    const response = handleGitHubLogin(
      new Request(`${API_ORIGIN}/auth/login`),
      productionEnv()
    );
    const authorizeUrl = new URL(response.headers.get("Location")!);
    const cookie = response.headers.get("Set-Cookie")!;

    expect(response.status).toBe(302);
    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/auth/callback`
    );
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
    expect(cookie).toContain("__Host-gh_oauth_state=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
  });
});

describe("authenticated WebSocket boundary", () => {
  it("rejects missing and invalid tokens before routing", async () => {
    const routeSubAgent = vi.fn();
    const think = { router: { routeSubAgent } } as unknown as ThinkAppContext;
    const env = productionEnv();

    const missing = await handleWebSocketUpgrade(
      websocketRequest(`${API_ORIGIN}/chat`, FRONTEND_ORIGIN),
      env,
      think
    );
    expect(missing.status).toBe(401);

    const invalid = await handleWebSocketUpgrade(
      websocketRequest(
        `${API_ORIGIN}/chat?ws_token=invalid`,
        FRONTEND_ORIGIN
      ),
      env,
      think
    );
    expect(invalid.status).toBe(401);
    expect(routeSubAgent).not.toHaveBeenCalled();
  });

  it("rejects a wrong Origin even with a valid token", async () => {
    const env = productionEnv();
    const token = await productionToken(env);
    const response = await handleWebSocketUpgrade(
      websocketRequest(
        `${API_ORIGIN}/chat?ws_token=${encodeURIComponent(token)}`,
        "https://evil.zyking.xyz"
      ),
      env,
      { router: { routeSubAgent: vi.fn() } } as unknown as ThinkAppContext
    );
    expect(response.status).toBe(403);
  });

  it("removes only ws_token and returns Think's 101 response unchanged", async () => {
    const registerAuthenticatedUser = vi.fn().mockResolvedValue(undefined);
    const directory = {
      setName: vi.fn().mockResolvedValue(undefined),
      registerAuthenticatedUser,
      fetch: vi.fn()
    };
    const namespace = {
      idFromName: vi.fn(() => ({ name: "github-11750878" })),
      get: vi.fn(() => directory)
    };
    const env = productionEnv({
      AssistantDirectory: namespace as unknown as Env["AssistantDirectory"]
    });
    const token = await productionToken(env);
    const pair = new WebSocketPair();
    const upgradeResponse = new Response(null, {
      status: 101,
      webSocket: pair[1]
    });
    let forwardedUrl = "";
    const routeSubAgent = vi.fn(async (request: Request) => {
      forwardedUrl = request.url;
      return upgradeResponse;
    });

    const response = await handleWebSocketUpgrade(
      websocketRequest(
        `${API_ORIGIN}/chat?ws_token=${encodeURIComponent(token)}&_pk=client-1`,
        FRONTEND_ORIGIN
      ),
      env,
      { router: { routeSubAgent } }
    );

    expect(response).toBe(upgradeResponse);
    expect(response.status).toBe(101);
    expect(forwardedUrl).not.toContain("ws_token");
    expect(forwardedUrl).toContain("_pk=client-1");
    expect(registerAuthenticatedUser).toHaveBeenCalledWith({
      id: 11750878,
      login: "lusess123"
    });
    pair[0].accept();
    pair[0].close();
  });
});

function websocketRequest(url: string, origin: string) {
  return new Request(url, {
    headers: { Origin: origin, Upgrade: "websocket" }
  });
}

function productionToken(env: HttpBindings) {
  return createWebSocketToken({
    user: {
      id: 11750878,
      login: "lusess123",
      name: null,
      avatarUrl: ""
    },
    isDevUser: false,
    frontendOrigin: FRONTEND_ORIGIN,
    apiOrigin: API_ORIGIN,
    env
  });
}
