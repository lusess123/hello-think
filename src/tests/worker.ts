/**
 * Test worker for the assistant example.
 *
 * This worker is **not** the production worker. It re-exports the
 * production `AssistantDirectory` and `MyAssistant` classes verbatim
 * (so the harness exercises real code, not a fork) but replaces the
 * surrounding plumbing:
 *
 *   - GitHub OAuth gating is dropped entirely. The production worker's
 *     responsibility is to authenticate the user and forward `/chat*`
 *     into the right `AssistantDirectory`. That's a Worker concern, not
 *     a multi-session-correctness concern, so the test worker uses a
 *     bare `routeAgentRequest` so tests can address directories by name
 *     directly.
 *
 *   - Dynamic Worker features are intentionally absent, matching the
 *     free-plan production deployment. The shared workspace, chat routing,
 *     story workspace, and MCP plumbing do not depend on a Worker Loader.
 *
 * No AI Gateway configuration is declared. Tests deliberately don't trigger turns —
 * `MyAssistant.getModel()` is never called. That means we don't have
 * to call the remote provider, and the
 * harness focuses on the plumbing the example owns: directory CRUD,
 * `SharedWorkspace` round-trips, change broadcasts, and the MCP
 * empty-state path. See `shared-mcp.test.ts` for why the deep MCP
 * round-trip is out of scope here.
 */

import { routeAgentRequest } from "agents";

export { AssistantDirectory } from "../../agents/assistant/agent";
export { MyAssistant } from "../../agents/assistant/agents/my-assistant/agent";

import type { AssistantDirectory } from "../../agents/assistant/agent";
import type { MyAssistant } from "../../agents/assistant/agents/my-assistant/agent";

export type Env = {
  AssistantDirectory: DurableObjectNamespace<AssistantDirectory>;
  MyAssistant: DurableObjectNamespace<MyAssistant>;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
