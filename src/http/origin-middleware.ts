import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import {
  canonicalApiOrigin,
  isAllowedFrontendOrigin,
  isMcpCallbackNavigation
} from "./origins";

const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE"];
const ALLOWED_METHOD_SET = new Set(ALLOWED_METHODS);
const ALLOWED_HEADER_NAMES = [
  "Accept",
  "Content-Type",
  "X-DSL-CSRF",
  "X-File-Name"
];
const ALLOWED_HEADER_SET = new Set(
  ALLOWED_HEADER_NAMES.map((header) => header.toLowerCase())
);

type OriginMiddlewareEnv = {
  Bindings: Env;
};

function forbidden() {
  return Response.json(
    { error: "请求来源不受信任" },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Reject disallowed origins before CORS has a chance to create a response.
 * CORS controls whether a browser may read a response; this gate also prevents
 * state changes and cross-site WebSocket-adjacent HTTP calls.
 */
export const strictOriginGate = createMiddleware<OriginMiddlewareEnv>(
  async (c, next) => {
    canonicalApiOrigin(c.req.raw, c.env);

    // OAuth providers return to this authenticated GET endpoint as a top-level
    // navigation. It deliberately does not participate in frontend CORS.
    if (isMcpCallbackNavigation(c.req.raw)) {
      await next();
      return;
    }

    const origin = c.req.header("Origin");
    if (origin && !isAllowedFrontendOrigin(origin, c.req.raw, c.env)) {
      return forbidden();
    }

    if (c.req.method === "OPTIONS") {
      if (!origin) return forbidden();
      const requestedMethod = c.req.header("Access-Control-Request-Method");
      if (!requestedMethod || !ALLOWED_METHOD_SET.has(requestedMethod.toUpperCase())) {
        return forbidden();
      }

      const requestedHeaders = c.req
        .header("Access-Control-Request-Headers")
        ?.split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (requestedHeaders?.some((header) => !ALLOWED_HEADER_SET.has(header))) {
        return forbidden();
      }
    } else if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      !origin
    ) {
      return forbidden();
    }

    await next();
    c.header("Cache-Control", "no-store");
  }
);

const honoCors = cors({
  origin: (origin, c) =>
    isAllowedFrontendOrigin(origin, c.req.raw, c.env as Env)
      ? origin
      : undefined,
  allowMethods: ALLOWED_METHODS,
  allowHeaders: ALLOWED_HEADER_NAMES,
  credentials: true,
  maxAge: 600
});

/** Keep the MCP OAuth callback out of CORS while covering every API outcome. */
export const exactCredentialedCors = createMiddleware<OriginMiddlewareEnv>(
  async (c, next) => {
    if (isMcpCallbackNavigation(c.req.raw)) {
      await next();
      return;
    }
    return honoCors(c, next);
  }
);
