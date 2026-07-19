import type { GitHubUser } from "../auth";

export const WS_TOKEN_QUERY_PARAM = "ws_token";

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 60;
const MAX_TOKEN_LENGTH = 2048;
const encoder = new TextEncoder();

type WebSocketTokenEnv = {
  WS_TOKEN_SECRET?: string;
};

type WebSocketTokenClaims = {
  v: typeof TOKEN_VERSION;
  sub: number;
  login: string;
  dev: boolean;
  origin: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
};

export type VerifiedWebSocketIdentity = {
  user: GitHubUser;
  isDevUser: boolean;
};

export async function createWebSocketToken(input: {
  user: GitHubUser;
  isDevUser: boolean;
  frontendOrigin: string;
  apiOrigin: string;
  env: WebSocketTokenEnv;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const claims: WebSocketTokenClaims = {
    v: TOKEN_VERSION,
    sub: input.user.id,
    login: input.user.login,
    dev: input.isDevUser,
    origin: input.frontendOrigin,
    aud: input.apiOrigin,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID()
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await sign(payload, input.env);
  return `${payload}.${base64UrlEncode(signature)}`;
}

export async function verifyWebSocketToken(input: {
  token: string;
  frontendOrigin: string;
  apiOrigin: string;
  env: WebSocketTokenEnv;
  now?: number;
}): Promise<VerifiedWebSocketIdentity | null> {
  if (!input.token || input.token.length > MAX_TOKEN_LENGTH) return null;
  const [payload, encodedSignature, extra] = input.token.split(".");
  if (!payload || !encodedSignature || extra) return null;

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(encodedSignature);
  } catch {
    return null;
  }
  if (!(await verify(payload, signature, input.env))) return null;

  let claims: WebSocketTokenClaims;
  try {
    claims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload))
    ) as WebSocketTokenClaims;
  } catch {
    return null;
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    claims.v !== TOKEN_VERSION ||
    !Number.isSafeInteger(claims.sub) ||
    claims.sub < 0 ||
    typeof claims.login !== "string" ||
    !claims.login ||
    typeof claims.dev !== "boolean" ||
    claims.origin !== input.frontendOrigin ||
    claims.aud !== input.apiOrigin ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > now + 5 ||
    claims.exp <= now ||
    claims.exp - claims.iat !== TOKEN_TTL_SECONDS ||
    typeof claims.jti !== "string" ||
    !claims.jti
  ) {
    return null;
  }

  return {
    user: {
      id: claims.sub,
      login: claims.login,
      name: null,
      avatarUrl: ""
    },
    isDevUser: claims.dev
  };
}

function secret(env: WebSocketTokenEnv): string {
  const value = env.WS_TOKEN_SECRET?.trim();
  if (!value) throw new Error("缺少 WS_TOKEN_SECRET 配置");
  if (encoder.encode(value).byteLength < 32) {
    throw new Error("WS_TOKEN_SECRET 至少需要 32 字节");
  }
  return value;
}

async function hmacKey(env: WebSocketTokenEnv): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(payload: string, env: WebSocketTokenEnv) {
  const result = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env),
    encoder.encode(payload)
  );
  return new Uint8Array(result);
}

async function verify(
  payload: string,
  signature: Uint8Array,
  env: WebSocketTokenEnv
) {
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(env),
    Uint8Array.from(signature).buffer,
    encoder.encode(payload)
  );
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
