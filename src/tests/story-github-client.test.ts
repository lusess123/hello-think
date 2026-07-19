import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  GitHubAppClient,
  GitHubApiError,
  GitHubConflictError,
  githubPrivateKeyToPkcs8,
} from "../../agents/assistant/story/github-app-client";

let privateKeyPem = "";

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/g)!.join("\n");
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHubAppClient", () => {
  it("signs as an App, caches the short-lived installation token and never returns it", async () => {
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      const headers = new Headers(init?.headers);
      const authorization = headers.get("Authorization") ?? "";
      expect(headers.get("User-Agent")).toBe("hello-think-story-workspace");
      if (url.pathname.includes("/access_tokens")) {
        expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
        return jsonResponse({
          token: "installation-secret",
          expires_at: "2030-01-01T01:00:00Z",
        });
      }
      expect(authorization).toBe("Bearer installation-secret");
      return jsonResponse({
        full_name: "lusess123/dsl-data",
        default_branch: "main",
        private: false,
      });
    });
    const client = new GitHubAppClient({
      appId: "123",
      installationId: "147497819",
      privateKey: privateKeyPem,
      owner: "lusess123",
      repo: "dsl-data",
      now: () => Date.parse("2030-01-01T00:00:00Z"),
      fetch: fetcher,
    });

    await expect(client.getRepository()).resolves.toEqual({
      fullName: "lusess123/dsl-data",
      defaultBranch: "main",
      private: false,
    });
    await client.getRepository();
    expect(fetcher.mock.calls.filter(([request]) => String(request).includes("access_tokens"))).toHaveLength(1);
  });

  it("creates a non-force Git commit from blob, tree, commit and ref calls", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, body });
      if (url.pathname.includes("/access_tokens")) {
        return jsonResponse({ token: "token", expires_at: "2030-01-01T01:00:00Z" });
      }
      if (method === "GET" && url.pathname.includes("/git/ref/")) {
        return jsonResponse({ ref: "refs/heads/drafts/tester", object: { sha: "head-a" } });
      }
      if (method === "GET" && url.pathname.includes("/git/commits/")) {
        return jsonResponse({ sha: "head-a", message: "old", tree: { sha: "tree-a" } });
      }
      if (url.pathname.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-b" }, 201);
      if (url.pathname.endsWith("/git/trees")) return jsonResponse({ sha: "tree-b" }, 201);
      if (method === "POST" && url.pathname.endsWith("/git/commits")) {
        return jsonResponse({ sha: "commit-b", message: "保存人物关系", tree: { sha: "tree-b" } }, 201);
      }
      if (method === "PATCH" && url.pathname.includes("/git/refs/")) {
        return jsonResponse({ ref: "refs/heads/drafts/tester", object: { sha: "commit-b" } });
      }
      return jsonResponse({ message: "unexpected" }, 500);
    });
    const client = new GitHubAppClient({
      appId: "123",
      installationId: "147497819",
      privateKey: privateKeyPem,
      owner: "lusess123",
      repo: "dsl-data",
      now: () => Date.parse("2030-01-01T00:00:00Z"),
      fetch: fetcher,
    });

    const commit = await client.commitFile({
      path: "stories/default/story.json",
      branch: "drafts/tester",
      content: "{}\n",
      message: "保存人物关系",
      expectedHeadSha: "head-a",
    });

    expect(commit.sha).toBe("commit-b");
    expect(requests.find((request) => request.path.endsWith("/git/trees"))?.body).toEqual({
      base_tree: "tree-a",
      tree: [
        {
          path: "stories/default/story.json",
          mode: "100644",
          type: "blob",
          sha: "blob-b",
        },
      ],
    });
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      sha: "commit-b",
      force: false,
    });
  });

  it("maps a competing ref update to a conflict with the current remote SHA", async () => {
    let refReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      const method = init?.method ?? "GET";
      if (url.pathname.includes("/access_tokens")) {
        return jsonResponse({ token: "token", expires_at: "2030-01-01T01:00:00Z" });
      }
      if (method === "GET" && url.pathname.includes("/git/ref/")) {
        refReads += 1;
        return jsonResponse({
          ref: "refs/heads/drafts/tester",
          object: { sha: refReads === 1 ? "head-a" : "head-remote" },
        });
      }
      if (method === "GET" && url.pathname.includes("/git/commits/")) {
        return jsonResponse({ sha: "head-a", message: "old", tree: { sha: "tree-a" } });
      }
      if (url.pathname.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-b" }, 201);
      if (url.pathname.endsWith("/git/trees")) return jsonResponse({ sha: "tree-b" }, 201);
      if (method === "POST" && url.pathname.endsWith("/git/commits")) {
        return jsonResponse({ sha: "commit-b", message: "save", tree: { sha: "tree-b" } }, 201);
      }
      if (method === "PATCH" && url.pathname.includes("/git/refs/")) {
        return jsonResponse({ message: "Reference update failed" }, 422);
      }
      return jsonResponse({ message: "unexpected" }, 500);
    });
    const client = new GitHubAppClient({
      appId: "123",
      installationId: "147497819",
      privateKey: privateKeyPem,
      owner: "lusess123",
      repo: "dsl-data",
      now: () => Date.parse("2030-01-01T00:00:00Z"),
      fetch: fetcher,
    });

    const error = await client.commitFile({
      path: "stories/default/story.json",
      branch: "drafts/tester",
      content: "{}\n",
      message: "save",
      expectedHeadSha: "head-a",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(GitHubConflictError);
    expect(error).toMatchObject({ expectedSha: "head-a", actualSha: "head-remote" });
  });

  it("returns an existing open pull request after GitHub reports a duplicate", async () => {
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      const method = init?.method ?? "GET";
      if (url.pathname.includes("/access_tokens")) {
        return jsonResponse({ token: "token", expires_at: "2030-01-01T01:00:00Z" });
      }
      if (method === "POST" && url.pathname.endsWith("/pulls")) {
        return jsonResponse({ message: "Validation Failed" }, 422);
      }
      if (method === "GET" && url.pathname.endsWith("/pulls")) {
        expect(url.searchParams.get("head")).toBe("lusess123:drafts/tester");
        expect(url.searchParams.get("base")).toBe("main");
        return jsonResponse([{
          number: 7,
          url: "https://api.github.test/pulls/7",
          html_url: "https://github.test/pulls/7",
          state: "open",
        }]);
      }
      return jsonResponse({ message: "unexpected" }, 500);
    });
    const client = new GitHubAppClient({
      appId: "123",
      installationId: "147497819",
      privateKey: privateKeyPem,
      owner: "lusess123",
      repo: "dsl-data",
      now: () => Date.parse("2030-01-01T00:00:00Z"),
      fetch: fetcher,
    });

    await expect(client.createPullRequest({
      title: "更新剧本",
      head: "drafts/tester",
      base: "main",
    })).resolves.toMatchObject({ number: 7, state: "open" });
  });

  it("wraps PKCS#1 keys as a PKCS#8 DER sequence", () => {
    const pkcs1 = Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x00);
    let binary = "";
    for (const byte of pkcs1) binary += String.fromCharCode(byte);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${btoa(binary)}\n-----END RSA PRIVATE KEY-----`;
    const pkcs8 = githubPrivateKeyToPkcs8(pem);
    expect(pkcs8[0]).toBe(0x30);
    expect([...pkcs8.slice(-pkcs1.length)]).toEqual([...pkcs1]);
  });

  it("exposes sanitized GitHub errors without credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async (request) => {
      const pathname = new URL(typeof request === "string" ? request : request.url).pathname;
      if (pathname.includes("access_tokens")) {
        return jsonResponse({ token: "never-print-me", expires_at: "2030-01-01T01:00:00Z" });
      }
      return jsonResponse({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    });
    const client = new GitHubAppClient({
      appId: "123",
      installationId: "147497819",
      privateKey: privateKeyPem,
      owner: "lusess123",
      repo: "dsl-data",
      now: () => Date.parse("2030-01-01T00:00:00Z"),
      fetch: fetcher,
    });

    const error = await client.getRef("missing").catch((caught) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String(error)).not.toContain("never-print-me");
  });
});
