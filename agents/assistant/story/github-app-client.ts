export interface StoryGitHubEnv {
  STORY_GITHUB_APP_ID: string;
  STORY_GITHUB_INSTALLATION_ID: string;
  STORY_GITHUB_PRIVATE_KEY: string;
  STORY_GITHUB_OWNER: string;
  STORY_GITHUB_REPO: string;
  STORY_GITHUB_DEFAULT_BRANCH?: string;
}

export interface GitHubAppClientConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface GitHubRef {
  ref: string;
  sha: string;
}

export interface GitHubCommit {
  sha: string;
  treeSha: string;
  message: string;
  htmlUrl?: string;
}

export interface GitHubTreeEntry {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  sha: string | null;
}

export interface GitHubContent {
  path: string;
  sha: string;
  content: string;
}

export interface GitHubBlob {
  sha: string;
  size: number;
  content: string;
}

export interface GitHubVersion {
  sha: string;
  message: string;
  authoredAt: string | null;
  authorName: string | null;
  authorLogin: string | null;
  htmlUrl: string;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  htmlUrl: string;
  state: string;
}

interface InstallationToken {
  token: string;
  expiresAt: number;
}

interface ApiErrorBody {
  message?: unknown;
  documentation_url?: unknown;
}

/** Error messages are deliberately limited to GitHub's public diagnostics. */
export class GitHubApiError extends Error {
  readonly code = "GITHUB_API_ERROR";

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
    readonly documentationUrl?: string
  ) {
    super(`GitHub API ${method} ${path} failed (${status}): ${message}`);
    this.name = "GitHubApiError";
  }
}

export class GitHubConflictError extends Error {
  readonly code = "GITHUB_HEAD_CONFLICT";

  constructor(
    readonly expectedSha: string,
    readonly actualSha: string
  ) {
    super(`GitHub 分支已经更新（期望 ${expectedSha.slice(0, 7)}，当前 ${actualSha.slice(0, 7)}）`);
    this.name = "GitHubConflictError";
  }
}

export function githubAppConfigFromEnv(env: StoryGitHubEnv): GitHubAppClientConfig {
  return {
    appId: required(env.STORY_GITHUB_APP_ID, "STORY_GITHUB_APP_ID"),
    installationId: required(
      env.STORY_GITHUB_INSTALLATION_ID,
      "STORY_GITHUB_INSTALLATION_ID"
    ),
    privateKey: required(env.STORY_GITHUB_PRIVATE_KEY, "STORY_GITHUB_PRIVATE_KEY"),
    owner: required(env.STORY_GITHUB_OWNER, "STORY_GITHUB_OWNER"),
    repo: required(env.STORY_GITHUB_REPO, "STORY_GITHUB_REPO"),
    defaultBranch: env.STORY_GITHUB_DEFAULT_BRANCH?.trim() || "main",
  };
}

/**
 * Small Git Data API client authenticated as a GitHub App installation.
 * It never returns or logs the App JWT / installation token.
 */
export class GitHubAppClient {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;

  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKey: string;
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private token?: InstallationToken;
  private tokenRequest?: Promise<InstallationToken>;
  private signingKey?: Promise<CryptoKey>;

  constructor(config: GitHubAppClientConfig) {
    this.appId = required(config.appId, "appId");
    this.installationId = required(config.installationId, "installationId");
    this.privateKey = required(config.privateKey, "privateKey").replace(/\\n/g, "\n");
    this.owner = required(config.owner, "owner");
    this.repo = required(config.repo, "repo");
    this.defaultBranch = config.defaultBranch?.trim() || "main";
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    // Workers' global fetch is brand-checked. Storing it directly and later
    // calling `this.fetcher(...)` would bind `this` to GitHubAppClient and
    // fail with "Illegal invocation". The wrapper preserves a plain call.
    this.fetcher =
      config.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.now = config.now ?? Date.now;
  }

  async getRepository(): Promise<{
    fullName: string;
    defaultBranch: string;
    private: boolean;
  }> {
    const response = await this.installationRequest<{
      full_name: string;
      default_branch: string;
      private: boolean;
    }>("GET", this.repoPath());
    return {
      fullName: response.full_name,
      defaultBranch: response.default_branch,
      private: response.private,
    };
  }

  async getRef(branch: string): Promise<GitHubRef> {
    const ref = `heads/${required(branch, "branch")}`;
    const response = await this.installationRequest<{
      ref: string;
      object: { sha: string };
    }>("GET", `${this.repoPath()}/git/ref/${encodeGitPath(ref)}`);
    return { ref: response.ref, sha: response.object.sha };
  }

  async createRef(branch: string, sha: string): Promise<GitHubRef> {
    const response = await this.installationRequest<{
      ref: string;
      object: { sha: string };
    }>("POST", `${this.repoPath()}/git/refs`, {
      ref: `refs/heads/${required(branch, "branch")}`,
      sha: required(sha, "sha"),
    });
    return { ref: response.ref, sha: response.object.sha };
  }

  async ensureBranch(branch: string, fromBranch = this.defaultBranch): Promise<GitHubRef> {
    try {
      return await this.getRef(branch);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      const base = await this.getRef(fromBranch);
      try {
        return await this.createRef(branch, base.sha);
      } catch (createError) {
        // A concurrent initializer may have created the same branch.
        if (!(createError instanceof GitHubApiError) || createError.status !== 422) {
          throw createError;
        }
        return this.getRef(branch);
      }
    }
  }

  async updateRef(branch: string, sha: string): Promise<GitHubRef> {
    const ref = `heads/${required(branch, "branch")}`;
    const response = await this.installationRequest<{
      ref: string;
      object: { sha: string };
    }>("PATCH", `${this.repoPath()}/git/refs/${encodeGitPath(ref)}`, {
      sha: required(sha, "sha"),
      force: false,
    });
    return { ref: response.ref, sha: response.object.sha };
  }

  async getCommit(sha: string): Promise<GitHubCommit> {
    const response = await this.installationRequest<{
      sha: string;
      message: string;
      tree: { sha: string };
      html_url?: string;
    }>("GET", `${this.repoPath()}/git/commits/${encodeURIComponent(required(sha, "sha"))}`);
    return {
      sha: response.sha,
      treeSha: response.tree.sha,
      message: response.message,
      htmlUrl: response.html_url,
    };
  }

  async getTree(
    sha: string,
    options: { recursive?: boolean } = {}
  ): Promise<{ sha: string; truncated: boolean; tree: GitHubTreeEntry[] }> {
    const query = options.recursive ? "?recursive=1" : "";
    const response = await this.installationRequest<{
      sha: string;
      truncated: boolean;
      tree: Array<{
        path: string;
        mode: GitHubTreeEntry["mode"];
        type: GitHubTreeEntry["type"];
        sha: string;
      }>;
    }>(
      "GET",
      `${this.repoPath()}/git/trees/${encodeURIComponent(required(sha, "sha"))}${query}`
    );
    return { sha: response.sha, truncated: response.truncated, tree: response.tree };
  }

  async createBlob(content: string): Promise<string> {
    const response = await this.installationRequest<{ sha: string }>(
      "POST",
      `${this.repoPath()}/git/blobs`,
      { content, encoding: "utf-8" }
    );
    return response.sha;
  }

  async getBlob(sha: string): Promise<GitHubBlob> {
    const response = await this.installationRequest<{
      sha: string;
      size: number;
      encoding: string;
      content: string;
    }>("GET", `${this.repoPath()}/git/blobs/${encodeURIComponent(required(sha, "sha"))}`);
    if (response.encoding !== "base64") {
      throw new Error(`GitHub blob 不是 base64 内容：${sha}`);
    }
    return {
      sha: response.sha,
      size: response.size,
      content: decodeBase64Text(response.content.replace(/\s/g, "")),
    };
  }

  async createTree(baseTreeSha: string, entries: GitHubTreeEntry[]): Promise<string> {
    const response = await this.installationRequest<{ sha: string }>(
      "POST",
      `${this.repoPath()}/git/trees`,
      { base_tree: required(baseTreeSha, "baseTreeSha"), tree: entries }
    );
    return response.sha;
  }

  async createCommit(message: string, treeSha: string, parentShas: string[]): Promise<GitHubCommit> {
    const response = await this.installationRequest<{
      sha: string;
      message: string;
      tree: { sha: string };
      html_url?: string;
    }>("POST", `${this.repoPath()}/git/commits`, {
      message: required(message, "message"),
      tree: required(treeSha, "treeSha"),
      parents: parentShas,
    });
    return {
      sha: response.sha,
      treeSha: response.tree.sha,
      message: response.message,
      htmlUrl: response.html_url,
    };
  }

  async getContent(path: string, ref: string): Promise<GitHubContent> {
    const query = new URLSearchParams({ ref: required(ref, "ref") });
    const response = await this.installationRequest<{
      path: string;
      sha: string;
      type: string;
      encoding: string;
      content: string;
    }>(
      "GET",
      `${this.repoPath()}/contents/${encodeGitPath(required(path, "path"))}?${query}`
    );
    if (response.type !== "file" || response.encoding !== "base64") {
      throw new Error(`GitHub 内容不是 base64 文件：${path}`);
    }
    return {
      path: response.path,
      sha: response.sha,
      content: decodeBase64Text(response.content.replace(/\s/g, "")),
    };
  }

  async listVersions(
    branch: string,
    path: string,
    options: { page?: number; perPage?: number } = {}
  ): Promise<GitHubVersion[]> {
    const query = new URLSearchParams({
      sha: required(branch, "branch"),
      path: required(path, "path"),
      page: String(Math.max(1, options.page ?? 1)),
      per_page: String(Math.min(100, Math.max(1, options.perPage ?? 30))),
    });
    const response = await this.installationRequest<
      Array<{
        sha: string;
        html_url: string;
        commit: {
          message: string;
          author: { name: string; date: string } | null;
        };
        author: { login: string } | null;
      }>
    >("GET", `${this.repoPath()}/commits?${query}`);
    return response.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      authoredAt: commit.commit.author?.date ?? null,
      authorName: commit.commit.author?.name ?? null,
      authorLogin: commit.author?.login ?? null,
      htmlUrl: commit.html_url,
    }));
  }

  async createPullRequest(input: {
    title: string;
    head: string;
    base?: string;
    body?: string;
    draft?: boolean;
  }): Promise<GitHubPullRequest> {
    type PullResponse = {
      number: number;
      url: string;
      html_url: string;
      state: string;
    };
    const head = required(input.head, "head");
    const base = input.base?.trim() || this.defaultBranch;
    let response: PullResponse;
    try {
      response = await this.installationRequest<PullResponse>(
        "POST",
        `${this.repoPath()}/pulls`,
        {
          title: required(input.title, "title"),
          head,
          base,
          body: input.body ?? "",
          draft: input.draft ?? false
        }
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      const query = new URLSearchParams({
        state: "open",
        head: `${this.owner}:${head}`,
        base
      });
      const existing = await this.installationRequest<PullResponse[]>(
        "GET",
        `${this.repoPath()}/pulls?${query}`
      );
      if (!existing[0]) throw error;
      response = existing[0];
    }
    return {
      number: response.number,
      url: response.url,
      htmlUrl: response.html_url,
      state: response.state
    };
  }

  async commitFile(input: {
    path: string;
    branch: string;
    content: string;
    message: string;
    expectedHeadSha: string;
  }): Promise<GitHubCommit> {
    return this.commitFiles({
      files: [{ path: input.path, content: input.content }],
      branch: input.branch,
      message: input.message,
      expectedHeadSha: input.expectedHeadSha,
    });
  }

  async commitFiles(input: {
    files: Array<{ path: string; content: string }>;
    branch: string;
    message: string;
    expectedHeadSha: string;
  }): Promise<GitHubCommit> {
    const head = await this.getRef(input.branch);
    if (head.sha !== input.expectedHeadSha) {
      throw new GitHubConflictError(input.expectedHeadSha, head.sha);
    }
    const parent = await this.getCommit(head.sha);
    const entries: GitHubTreeEntry[] = [];
    for (const file of input.files) {
      entries.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: await this.createBlob(file.content),
      });
    }
    const treeSha = await this.createTree(parent.treeSha, entries);
    const commit = await this.createCommit(input.message, treeSha, [head.sha]);
    try {
      await this.updateRef(input.branch, commit.sha);
    } catch (error) {
      // GitHub can reject the non-force ref update when another writer wins
      // between our initial HEAD check and PATCH. Resolve the current SHA so
      // callers can offer an explicit sync/rebase instead of surfacing a 502.
      if (
        !(error instanceof GitHubApiError) ||
        (error.status !== 409 && error.status !== 422)
      ) {
        throw error;
      }
      const actual = await this.getRef(input.branch);
      throw new GitHubConflictError(input.expectedHeadSha, actual.sha);
    }
    return commit;
  }

  private repoPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  private async installationRequest<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    let token = await this.installationToken();
    try {
      return await this.request<T>(method, path, token, body);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 401) throw error;
      this.token = undefined;
      token = await this.installationToken();
      return this.request<T>(method, path, token, body);
    }
  }

  private async installationToken(): Promise<string> {
    const now = this.now();
    if (this.token && now < this.token.expiresAt - 60_000) return this.token.token;

    this.tokenRequest ??= this.requestInstallationToken();
    try {
      this.token = await this.tokenRequest;
      return this.token.token;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async requestInstallationToken(): Promise<InstallationToken> {
    const jwt = await this.appJwt();
    const response = await this.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`,
      jwt,
      undefined
    );
    const expiresAt = Date.parse(response.expires_at);
    if (!response.token || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub 返回了无效的 installation token 响应");
    }
    return { token: response.token, expiresAt };
  }

  private async appJwt(): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
    const payload = base64UrlJson({ iat: now - 60, exp: now + 540, iss: this.appId });
    const unsigned = `${header}.${payload}`;
    this.signingKey ??= importGitHubAppPrivateKey(this.privateKey);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await this.signingKey,
      new TextEncoder().encode(unsigned)
    );
    return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
  }

  private async request<T>(
    method: string,
    path: string,
    bearer: string,
    body?: unknown
  ): Promise<T> {
    const response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        "User-Agent": "hello-think-story-workspace",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const parsed = await safeApiError(response);
      throw new GitHubApiError(
        response.status,
        method,
        path.split("?")[0],
        parsed.message,
        parsed.documentationUrl
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

async function safeApiError(response: Response): Promise<{
  message: string;
  documentationUrl?: string;
}> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return {
      message: typeof body.message === "string" ? body.message.slice(0, 500) : response.statusText,
      documentationUrl:
        typeof body.documentation_url === "string" ? body.documentation_url : undefined,
    };
  } catch {
    return { message: response.statusText || "unknown error" };
  }
}

function required(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function encodeGitPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Text(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodePem(pem: string): { label: string; bytes: Uint8Array } {
  const match = pem
    .trim()
    .match(/^-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----$/);
  if (!match) throw new Error("GitHub App 私钥不是有效的 PEM");
  const binary = atob(match[2].replace(/\s/g, ""));
  return {
    label: match[1],
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  };
}

/** Converts GitHub's PKCS#1 download to the PKCS#8 format WebCrypto accepts. */
export function githubPrivateKeyToPkcs8(pem: string): Uint8Array {
  const decoded = decodePem(pem);
  if (decoded.label === "PRIVATE KEY") return decoded.bytes;
  if (decoded.label !== "RSA PRIVATE KEY") {
    throw new Error(`不支持的 GitHub App 私钥类型：${decoded.label}`);
  }

  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00
  );
  const privateKey = derElement(0x04, decoded.bytes);
  return derElement(0x30, concat(version, rsaAlgorithmIdentifier, privateKey));
}

async function importGitHubAppPrivateKey(pem: string): Promise<CryptoKey> {
  const bytes = githubPrivateKeyToPkcs8(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(bytes).buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function derElement(tag: number, value: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), derLength(value.byteLength), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) {
    bytes.unshift(remaining & 0xff);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
