/**
 * Assistant API server entry.
 *
 * HTTP routes run through Hono. Authenticated WebSocket upgrades intentionally
 * stay outside Hono so no after-middleware can wrap or mutate the `101`
 * response returned by Think.
 */

import { isStoryUserAllowed } from "./access-control";
import { httpApp } from "./http/app";
import type { HttpBindings } from "./http/app";
import { routeAuthenticatedChat } from "./http/chat-routing";
import type { ThinkAppContext } from "./http/chat-routing";
import {
  canonicalApiOrigin,
  isAllowedFrontendOrigin,
  isWebSocketUpgrade
} from "./http/origins";
import {
  verifyWebSocketToken,
  WS_TOKEN_QUERY_PARAM
} from "./http/ws-token";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    think?: ThinkAppContext
  ) {
    const url = new URL(request.url);
    if (
      (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) &&
      isWebSocketUpgrade(request)
    ) {
      return handleWebSocketUpgrade(request, env, think);
    }

    // Think supplies its router as a fourth, request-scoped argument. Passing
    // it through the Hono bindings keeps concurrent requests isolated.
    const requestEnv: HttpBindings = { ...env, THINK_RUNTIME: think };
    return httpApp.fetch(request, requestEnv, ctx);
  }
};

export async function handleWebSocketUpgrade(
  request: Request,
  env: Env,
  think: ThinkAppContext | undefined
): Promise<Response> {
  let apiOrigin: string;
  const frontendOrigin = request.headers.get("Origin");
  try {
    apiOrigin = canonicalApiOrigin(request, env);
    if (
      !frontendOrigin ||
      !isAllowedFrontendOrigin(frontendOrigin, request, env)
    ) {
      return forbiddenOrigin();
    }
  } catch {
    return forbiddenOrigin();
  }

  const url = new URL(request.url);
  const token = url.searchParams.get(WS_TOKEN_QUERY_PARAM);
  if (!token) return unauthorizedWebSocket();

  let identity;
  try {
    identity = await verifyWebSocketToken({
      token,
      frontendOrigin,
      apiOrigin,
      env
    });
  } catch {
    return unauthorizedWebSocket();
  }
  if (!identity) return unauthorizedWebSocket();
  if (
    !isStoryUserAllowed(
      identity.user,
      env.STORY_ALLOWED_GITHUB_USERS,
      identity.isDevUser
    )
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  // Keep PartySocket parameters such as `_pk`, but never forward the bearer
  // token into Think, Durable Object logs, or stored request state.
  url.searchParams.delete(WS_TOKEN_QUERY_PARAM);
  const sanitizedRequest = new Request(url, request);
  return routeAuthenticatedChat({
    request: sanitizedRequest,
    env,
    think,
    user: identity.user,
    isDevUser: identity.isDevUser
  });
}

function forbiddenOrigin() {
  return new Response("Forbidden", {
    status: 403,
    headers: { "Cache-Control": "no-store" }
  });
}

function unauthorizedWebSocket() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "Cache-Control": "no-store" }
  });
}
