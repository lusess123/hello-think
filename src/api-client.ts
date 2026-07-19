const LOCAL_API_ORIGIN = "http://localhost";
const WS_TOKEN_CACHE_TTL_MS = 30_000;
const WS_TOKEN_QUERY_PARAM = "ws_token";

function configuredApiOrigin(): string | undefined {
  const value = import.meta.env.VITE_API_ORIGIN?.trim();
  return value || undefined;
}

function browserOrigin(): string {
  return typeof window === "undefined" ? LOCAL_API_ORIGIN : window.location.origin;
}

/** Public browser API origin. Production injects VITE_API_ORIGIN at build time. */
export function apiOrigin(): string {
  return new URL(configuredApiOrigin() ?? browserOrigin()).origin;
}

/** Resolve both API paths and legacy relative document URLs against the API host. */
export function apiUrl(path: string | URL, origin = apiOrigin()): string {
  return new URL(path.toString(), `${new URL(origin).origin}/`).toString();
}

/** All browser API calls are credentialed because auth is an API-host cookie. */
export function apiFetch(
  path: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    credentials: "include"
  });
}

type WebSocketTokenResponse = {
  token?: unknown;
};

/**
 * PartySocket cannot attach a custom Authorization header. Obtain a short-lived
 * ticket over credentialed HTTP and pass only that ticket in the upgrade URL.
 */
export async function fetchAgentConnectionQuery(): Promise<{
  ws_token: string;
}> {
  const response = await apiFetch("/auth/ws-token", {
    method: "POST",
    headers: { Accept: "application/json" }
  });
  const body = (await response.json().catch(() => ({}))) as WebSocketTokenResponse;
  if (!response.ok || typeof body.token !== "string" || !body.token) {
    throw new Error(`Failed to obtain WebSocket token (HTTP ${response.status})`);
  }
  return { [WS_TOKEN_QUERY_PARAM]: body.token };
}

export const agentConnectionOptions = {
  host: apiOrigin(),
  query: fetchAgentConnectionQuery,
  cacheTtl: WS_TOKEN_CACHE_TTL_MS
} as const;
