import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { isStoryUserAllowed } from "../access-control";
import {
  createUnauthorizedResponse,
  getDevUser,
  getGitHubUserFromRequest,
  handleGitHubCallback,
  handleGitHubLogin,
  handleLogout
} from "../auth";
import type { GitHubUser } from "../auth";
import { routeAuthenticatedChat } from "./chat-routing";
import type { ThinkAppContext } from "./chat-routing";
import { exactCredentialedCors, strictOriginGate } from "./origin-middleware";
import { canonicalApiOrigin } from "./origins";
import { createWebSocketToken } from "./ws-token";

export type HttpBindings = Env & {
  /** Request-scoped adapter value supplied by `src/server.ts`. */
  THINK_RUNTIME?: ThinkAppContext;
};

type HttpVariables = {
  authUser: GitHubUser;
  isDevUser: boolean;
};

type HttpAppEnv = {
  Bindings: HttpBindings;
  Variables: HttpVariables;
};

const app = new Hono<HttpAppEnv>();

const credentialedPaths = [
  "/auth/me",
  "/auth/logout",
  "/auth/ws-token",
  "/chat",
  "/chat/*"
] as const;

for (const path of credentialedPaths) {
  app.use(path, strictOriginGate, exactCredentialedCors);
}

const requireAuthenticatedUser = createMiddleware<HttpAppEnv>(async (c, next) => {
  const devUser = getDevUser(c.req.raw, c.env);
  const user = devUser ?? (await getGitHubUserFromRequest(c.req.raw));
  if (!user) return createUnauthorizedResponse(c.req.raw);
  if (
    !isStoryUserAllowed(
      user,
      c.env.STORY_ALLOWED_GITHUB_USERS,
      Boolean(devUser)
    )
  ) {
    return forbiddenUser();
  }

  c.set("authUser", user);
  c.set("isDevUser", Boolean(devUser));
  await next();
});

app.get("/auth/login", (c) => handleGitHubLogin(c.req.raw, c.env));
app.get("/auth/callback", (c) => handleGitHubCallback(c.req.raw, c.env));

app.get("/auth/me", requireAuthenticatedUser, (c) =>
  noStoreJson(c.var.authUser)
);

app.post("/auth/logout", (c) => handleLogout(c.req.raw));
app.all("/auth/logout", () => methodNotAllowed());

app.post("/auth/ws-token", requireAuthenticatedUser, async (c) => {
  const frontendOrigin = c.req.header("Origin");
  // `strictOriginGate` requires this header for POST; retain the explicit
  // check so this security boundary remains correct if route wiring changes.
  if (!frontendOrigin) return untrustedOrigin();
  const token = await createWebSocketToken({
    user: c.var.authUser,
    isDevUser: c.var.isDevUser,
    frontendOrigin,
    apiOrigin: canonicalApiOrigin(c.req.raw, c.env),
    env: c.env
  });
  return noStoreJson({ token });
});
app.all("/auth/ws-token", () => methodNotAllowed());

const chatHandler = async (c: Context<HttpAppEnv>) =>
  routeAuthenticatedChat({
    request: c.req.raw,
    env: c.env,
    think: c.env.THINK_RUNTIME,
    user: c.var.authUser,
    isDevUser: c.var.isDevUser
  });

app.all("/chat", requireAuthenticatedUser, chatHandler);
app.all("/chat/*", requireAuthenticatedUser, chatHandler);

app.notFound(() => new Response("Not found", { status: 404 }));
app.onError((error) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return noStoreJson({ error: message }, 500);
});

export const httpApp = app;

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function forbiddenUser() {
  return noStoreJson(
    { error: "当前 GitHub 用户没有这个剧本仓库的编辑权限" },
    403
  );
}

function untrustedOrigin() {
  return noStoreJson({ error: "请求来源不受信任" }, 403);
}

function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { "Cache-Control": "no-store" }
  });
}
