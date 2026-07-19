import { describe, expect, it } from "vitest";
import {
  createWebSocketToken,
  verifyWebSocketToken
} from "../http/ws-token";

const secret = "test-only-websocket-hmac-secret-32-bytes-long";
const env = { WS_TOKEN_SECRET: secret };
const user = {
  id: 11750878,
  login: "lusess123",
  name: "Test User",
  avatarUrl: "https://example.com/avatar.png"
};

describe("short-lived WebSocket tokens", () => {
  it("binds a signed identity to the frontend and API origins", async () => {
    const token = await createWebSocketToken({
      user,
      isDevUser: false,
      frontendOrigin: "https://dsl.zyking.xyz",
      apiOrigin: "https://dsl-api.zyking.xyz",
      env,
      now: 1_000
    });

    await expect(
      verifyWebSocketToken({
        token,
        frontendOrigin: "https://dsl.zyking.xyz",
        apiOrigin: "https://dsl-api.zyking.xyz",
        env,
        now: 1_030
      })
    ).resolves.toEqual({
      user: {
        id: user.id,
        login: user.login,
        name: null,
        avatarUrl: ""
      },
      isDevUser: false
    });
  });

  it("rejects expired, wrong-origin, wrong-audience, and tampered tokens", async () => {
    const token = await createWebSocketToken({
      user,
      isDevUser: false,
      frontendOrigin: "https://dsl.zyking.xyz",
      apiOrigin: "https://dsl-api.zyking.xyz",
      env,
      now: 2_000
    });
    const common = { token, env };

    await expect(
      verifyWebSocketToken({
        ...common,
        frontendOrigin: "https://dsl.zyking.xyz",
        apiOrigin: "https://dsl-api.zyking.xyz",
        now: 2_060
      })
    ).resolves.toBeNull();
    await expect(
      verifyWebSocketToken({
        ...common,
        frontendOrigin: "https://evil.zyking.xyz",
        apiOrigin: "https://dsl-api.zyking.xyz",
        now: 2_030
      })
    ).resolves.toBeNull();
    await expect(
      verifyWebSocketToken({
        ...common,
        frontendOrigin: "https://dsl.zyking.xyz",
        apiOrigin: "https://other-api.zyking.xyz",
        now: 2_030
      })
    ).resolves.toBeNull();

    const replacement = token.endsWith("A") ? "B" : "A";
    await expect(
      verifyWebSocketToken({
        token: `${token.slice(0, -1)}${replacement}`,
        frontendOrigin: "https://dsl.zyking.xyz",
        apiOrigin: "https://dsl-api.zyking.xyz",
        env,
        now: 2_030
      })
    ).resolves.toBeNull();
  });

  it("fails closed without a sufficiently strong HMAC secret", async () => {
    await expect(
      createWebSocketToken({
        user,
        isDevUser: false,
        frontendOrigin: "https://dsl.zyking.xyz",
        apiOrigin: "https://dsl-api.zyking.xyz",
        env: { WS_TOKEN_SECRET: "short" }
      })
    ).rejects.toThrow("至少需要 32 字节");
  });
});
