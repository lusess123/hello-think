import { getAgentByName } from "agents";
import type { AssistantDirectory } from "../../agents/assistant/agent";
import type { GitHubUser } from "../auth";
import { storyDirectoryName } from "../access-control";

export type ThinkAppContext = {
  router: {
    routeSubAgent(
      request: Request,
      parent: { fetch(request: Request): Promise<Response> },
      options: { parent: string }
    ): Promise<Response>;
  };
};

export async function routeAuthenticatedChat(input: {
  request: Request;
  env: Env;
  think: ThinkAppContext | undefined;
  user: GitHubUser;
  isDevUser: boolean;
}): Promise<Response> {
  if (!input.think?.router) {
    return new Response(
      "Assistant chat routing requires the Think generated Worker entry. " +
        'Make sure the configured Worker main re-exports "virtual:think/entry", ' +
        "rebuild @cloudflare/think after framework changes, and restart the dev server.",
      { status: 500 }
    );
  }

  const directory = await getAgentByName(
    input.env.AssistantDirectory as DurableObjectNamespace<AssistantDirectory>,
    storyDirectoryName(input.user, input.isDevUser)
  );
  await directory.registerAuthenticatedUser({
    id: input.user.id,
    login: input.user.login
  });
  return input.think.router.routeSubAgent(input.request, directory, {
    parent: "assistant"
  });
}
