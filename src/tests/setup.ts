import { afterAll, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

// Warm up the worker module graph before tests run. The first
// fetch through the test worker triggers Vite's module resolution
// for the entire dependency tree (Think, ai-chat, agents/chat,
// codemode, kumo). On a cold CI runner, several suites can warm in parallel
// and take more than 30s, which would otherwise fail before tests start.
beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 60_000);

// Give DOs a moment to finish WebSocket close handlers before the
// module is invalidated between test files.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
