// Hand-maintained platform bindings for the assistant Worker.
//
// The typed `AssistantDirectory` Durable Object binding is generated into
// `think.d.ts` by `think types`. Keeping it out of this file avoids merging an
// untyped Wrangler declaration with Think's generated namespace.
declare namespace Cloudflare {
  interface Env {
    BROWSER: BrowserRun;
    R2: R2Bucket;
    DOCUMENT_INGEST_WORKFLOW: Workflow;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    DEV_USER: string;
    AI_GATEWAY_BASE_URL: string;
    AI_GATEWAY_TOKEN: string;
    AI_GATEWAY_PROVIDER_ALIAS: string;
    LLM_DEFAULT_MODEL: string;
    STORY_GITHUB_APP_ID: string;
    STORY_GITHUB_INSTALLATION_ID: string;
    STORY_GITHUB_PRIVATE_KEY: string;
    STORY_GITHUB_OWNER: string;
    STORY_GITHUB_REPO: string;
    STORY_GITHUB_DEFAULT_BRANCH: string;
    STORY_GITHUB_PATH: string;
    STORY_ALLOWED_GITHUB_USERS: string;
  }
}

interface Env extends Cloudflare.Env {}

declare namespace NodeJS {
  interface ProcessEnv {
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    STORY_GITHUB_PRIVATE_KEY: string;
  }
}
