export type CanonicalOriginEnv = {
  API_ORIGIN?: string;
  FRONTEND_ORIGIN?: string;
};

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

export function isLoopbackRequest(request: Request): boolean {
  return isLoopbackHostname(new URL(request.url).hostname);
}

/**
 * Return the only API origin this request is allowed to use.
 *
 * Production is deliberately fail-closed: the binding is required, must be
 * HTTPS, and must match the actual request origin. Loopback keeps `npm start`
 * zero-config and uses the Vite/Wrangler request origin.
 */
export function canonicalApiOrigin(
  request: Request,
  env: CanonicalOriginEnv
): string {
  const requestUrl = new URL(request.url);
  if (isLoopbackHostname(requestUrl.hostname)) return requestUrl.origin;

  const configured = parseConfiguredOrigin(env.API_ORIGIN, "API_ORIGIN", true);
  if (requestUrl.origin !== configured) {
    throw new Error("请求来源与 API_ORIGIN 不匹配");
  }
  return configured;
}

/** The fixed post-login destination. Never derive it from a return URL. */
export function canonicalFrontendOrigin(
  request: Request,
  env: CanonicalOriginEnv
): string {
  if (isLoopbackRequest(request)) {
    if (env.FRONTEND_ORIGIN) {
      const configured = parseConfiguredOrigin(
        env.FRONTEND_ORIGIN,
        "FRONTEND_ORIGIN",
        false
      );
      if (isAllowedLoopbackOrigin(configured)) return configured;
    }
    return new URL(request.url).origin;
  }

  return parseConfiguredOrigin(env.FRONTEND_ORIGIN, "FRONTEND_ORIGIN", true);
}

export function isAllowedFrontendOrigin(
  origin: string,
  request: Request,
  env: CanonicalOriginEnv
): boolean {
  // This also checks that production traffic arrived on the canonical API
  // hostname. A workers.dev fallback cannot silently become an OAuth/API host.
  canonicalApiOrigin(request, env);

  if (isLoopbackRequest(request)) return isAllowedLoopbackOrigin(origin);
  return origin === canonicalFrontendOrigin(request, env);
}

export function isAllowedLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

export function isMcpCallbackNavigation(request: Request): boolean {
  return (
    request.method === "GET" &&
    new URL(request.url).pathname === "/chat/mcp-callback"
  );
}

function parseConfiguredOrigin(
  value: string | undefined,
  name: string,
  requireHttps: boolean
): string {
  if (!value?.trim()) throw new Error(`缺少 ${name} 配置`);

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} 必须是完整的 origin`);
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} 只能包含协议、主机名和端口`);
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new Error(`${name} 在线上必须使用 HTTPS`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} 必须使用 HTTP 或 HTTPS`);
  }
  return url.origin;
}
