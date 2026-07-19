/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = import("./worker").Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {
    // Bindings declared in the production environment that the
    // test worker doesn't carry (auth secrets, AI Gateway). Tests
    // don't exercise the code paths that read these — auth lives in
    // the production Worker (which the test worker replaces) and AI
    // is only touched by `MyAssistant.getModel()` during turns
    // (which tests don't trigger). Declared here so `src/server.ts`
    // and `src/auth.ts` typecheck under the test tsconfig.
    AI_GATEWAY_BASE_URL: string;
    AI_GATEWAY_TOKEN: string;
    AI_GATEWAY_PROVIDER_ALIAS: string;
    LLM_DEFAULT_MODEL: string;
    // `BROWSER` is used by `MyAssistant.getTools()` to build the Quick Action
    // tools. The test worker doesn't bind it (tests never invoke those tools),
    // but the type is needed so the shared agent typechecks here.
    BROWSER: BrowserRun;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}

interface Env extends Cloudflare.Env {}
