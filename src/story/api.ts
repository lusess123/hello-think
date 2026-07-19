import type {
  MysteryStoryDsl,
  StoryCommit,
  StoryLayout,
  StoryPullRequest,
  StoryVersion,
  StoryWorkspace,
  StoryWorkspaceEvent
} from "./types";
import { apiFetch } from "../api-client";

const STORY_API = "/chat/story";

export class StoryApiError extends Error {
  readonly status: number;
  readonly currentWorkspace?: StoryWorkspace;

  constructor(
    message: string,
    status: number,
    currentWorkspace?: StoryWorkspace
  ) {
    super(message);
    this.name = "StoryApiError";
    this.status = status;
    this.currentWorkspace = currentWorkspace;
  }
}

export async function fetchStoryWorkspace(
  signal?: AbortSignal
): Promise<StoryWorkspace> {
  const body = await request<{ workspace: StoryWorkspace }>(STORY_API, {
    signal
  });
  return body.workspace;
}

export async function updateStoryWorkspace(input: {
  story: MysteryStoryDsl;
  expectedRevision: number;
  source:
    | "relationship-panel"
    | "timeline-panel"
    | "json-editor"
    | "agent";
  summary?: string;
}): Promise<StoryWorkspace> {
  const body = await request<{ workspace: StoryWorkspace }>(STORY_API, {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return body.workspace;
}

export async function updateStoryLayout(input: {
  layout: StoryLayout;
  expectedRevision: number;
  source: "design-layout";
  summary?: string;
}): Promise<StoryWorkspace> {
  const body = await request<{ workspace: StoryWorkspace }>(
    `${STORY_API}/layout`,
    {
      method: "PUT",
      body: JSON.stringify(input)
    }
  );
  return body.workspace;
}

export async function discardStoryWorkspace(
  expectedRevision: number
): Promise<StoryWorkspace> {
  const body = await request<{ workspace: StoryWorkspace }>(
    `${STORY_API}/discard`,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevision })
    }
  );
  return body.workspace;
}

export async function restoreStoryVersion(input: {
  sha: string;
  expectedRevision: number;
}): Promise<StoryWorkspace> {
  const body = await request<{ workspace: StoryWorkspace }>(
    `${STORY_API}/restore`,
    { method: "POST", body: JSON.stringify(input) }
  );
  return body.workspace;
}

export async function restoreStoryEvent(input: {
  eventId: number;
  expectedRevision: number;
}): Promise<StoryWorkspace> {
  const body = await request<{ workspace: StoryWorkspace }>(
    `${STORY_API}/restore-event`,
    { method: "POST", body: JSON.stringify(input) }
  );
  return body.workspace;
}

export async function syncStoryWorkspace(
  expectedRevision: number
): Promise<StoryWorkspace> {
  const body = await request<{ workspace: StoryWorkspace }>(
    `${STORY_API}/sync`,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevision })
    }
  );
  return body.workspace;
}

export async function commitStoryWorkspace(input: {
  message: string;
  expectedRevision: number;
}): Promise<{ workspace: StoryWorkspace; commit: StoryCommit | null }> {
  return request(`${STORY_API}/commit`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function fetchStoryHistory(input: {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<{ versions: StoryVersion[]; nextCursor?: string }> {
  const search = new URLSearchParams();
  if (input.cursor) search.set("cursor", input.cursor);
  search.set("limit", String(input.limit ?? 60));
  return request(`${STORY_API}/history?${search.toString()}`, {
    signal: input.signal
  });
}

export async function fetchStoryVersion(
  sha: string,
  signal?: AbortSignal
): Promise<{
  version: StoryVersion;
  story: MysteryStoryDsl;
  layout: StoryLayout;
}> {
  return request(`${STORY_API}/version/${encodeURIComponent(sha)}`, { signal });
}

export async function fetchStoryEvents(
  input: { limit?: number; beforeId?: number; signal?: AbortSignal } = {}
): Promise<{ events: StoryWorkspaceEvent[]; nextBeforeId?: number }> {
  const search = new URLSearchParams({ limit: String(input.limit ?? 200) });
  if (input.beforeId !== undefined) {
    search.set("beforeId", String(input.beforeId));
  }
  return request(`${STORY_API}/events?${search.toString()}`, {
    signal: input.signal
  });
}

export async function createStoryPullRequest(input: {
  title: string;
  body?: string;
}): Promise<StoryPullRequest> {
  const response = await request<{ pullRequest: StoryPullRequest }>(
    `${STORY_API}/pull-request`,
    { method: "POST", body: JSON.stringify(input) }
  );
  return response.pullRequest;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    currentWorkspace?: StoryWorkspace;
  } & T;
  if (!response.ok) {
    throw new StoryApiError(
      body.error ?? body.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      body.currentWorkspace
    );
  }
  return body;
}
