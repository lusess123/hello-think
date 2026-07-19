import {
  ArrowClockwiseIcon,
  ClockCounterClockwiseIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  SpinnerGapIcon
} from "@phosphor-icons/react";
import { Badge, Button } from "@cloudflare/kumo";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { VirtualList } from "../components/virtual-list";
import {
  createStoryPullRequest,
  fetchStoryEvents,
  fetchStoryHistory,
  fetchStoryVersion
} from "./api";
import type {
  MysteryStoryDsl,
  StoryPullRequest,
  StoryVersion,
  StoryWorkspace,
  StoryWorkspaceEvent
} from "./types";
import { mergeStoryEvents } from "./ui-model";
import {
  StoryEmpty,
  StorySectionHeader,
  STORY_INPUT_CLASS,
  STORY_PANEL_CLASS
} from "./story-ui";

export type StoryRestoreRequest =
  | { kind: "commit"; sha: string; label: string }
  | {
      kind: "event";
      eventId: number;
      revision: number;
      label: string;
    };

type HistorySelection =
  | { kind: "commit"; version: StoryVersion; story: MysteryStoryDsl }
  | { kind: "event"; event: StoryWorkspaceEvent };

export function HistoryView({
  workspace,
  disabled,
  onError,
  onNotice,
  onRequestRestore
}: {
  workspace: StoryWorkspace;
  disabled: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onRequestRestore: (request: StoryRestoreRequest) => void;
}) {
  const [versions, setVersions] = useState<StoryVersion[]>([]);
  const [events, setEvents] = useState<StoryWorkspaceEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [nextEventBeforeId, setNextEventBeforeId] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const [selection, setSelection] = useState<HistorySelection | null>(null);
  const [viewingSha, setViewingSha] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const versionSequence = useRef(0);
  const [prTitle, setPrTitle] = useState("更新默认悬疑剧本");
  const [prBody, setPrBody] = useState("");
  const [pullRequest, setPullRequest] = useState<StoryPullRequest | null>(null);

  const refresh = () => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    Promise.all([
      fetchStoryHistory({ limit: 80 }),
      fetchStoryEvents({ limit: 100 })
    ])
      .then(([history, eventHistory]) => {
        if (sequence !== refreshSequence.current) return;
        setVersions(history.versions);
        setNextCursor(history.nextCursor);
        setEvents(eventHistory.events);
        setNextEventBeforeId(eventHistory.nextBeforeId);
      })
      .catch((historyError) => {
        if (sequence === refreshSequence.current) {
          onError(`读取版本历史失败：${errorMessage(historyError)}`);
        }
      })
      .finally(() => {
        if (sequence === refreshSequence.current) setLoading(false);
      });
  };

  useEffect(() => {
    refresh();
    return () => {
      refreshSequence.current += 1;
      versionSequence.current += 1;
    };
    // Workspace revision invalidates the event rail; HEAD invalidates commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.baseCommitSha, workspace.revision]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchStoryHistory({ cursor: nextCursor, limit: 80 });
      setVersions((current) => {
        const known = new Set(current.map((version) => version.sha));
        return [...current, ...result.versions.filter((version) => !known.has(version.sha))];
      });
      setNextCursor(result.nextCursor);
    } catch (historyError) {
      onError(`读取更早版本失败：${errorMessage(historyError)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const loadMoreEvents = async () => {
    if (!nextEventBeforeId || loadingMoreEvents) return;
    const sequence = refreshSequence.current;
    setLoadingMoreEvents(true);
    try {
      const result = await fetchStoryEvents({
        beforeId: nextEventBeforeId,
        limit: 100
      });
      if (sequence !== refreshSequence.current) return;
      setEvents((current) => mergeStoryEvents(current, result.events));
      setNextEventBeforeId(result.nextBeforeId);
    } catch (historyError) {
      if (sequence === refreshSequence.current) {
        onError(`读取更早工作区留痕失败：${errorMessage(historyError)}`);
      }
    } finally {
      setLoadingMoreEvents(false);
    }
  };

  const viewVersion = async (version: StoryVersion) => {
    const sequence = ++versionSequence.current;
    setViewingSha(version.sha);
    try {
      const result = await fetchStoryVersion(version.sha);
      if (sequence !== versionSequence.current) return;
      setSelection({ kind: "commit", ...result });
    } catch (versionError) {
      if (sequence === versionSequence.current) {
        onError(`读取历史版本失败：${errorMessage(versionError)}`);
      }
    } finally {
      if (sequence === versionSequence.current) setViewingSha(null);
    }
  };

  const createPullRequest = async (event: FormEvent) => {
    event.preventDefault();
    if (!prTitle.trim() || disabled || workspace.dirty) return;
    try {
      const next = await createStoryPullRequest({
        title: prTitle.trim(),
        body: prBody.trim() || undefined
      });
      setPullRequest(next);
      onNotice(`Pull Request #${next.number} 已创建`);
    } catch (prError) {
      onError(`创建 Pull Request 失败：${errorMessage(prError)}`);
    }
  };

  const selectedStory =
    selection?.kind === "commit"
      ? selection.story
      : selection?.event.afterStory ?? selection?.event.beforeStory;

  return (
    <div className="story-history-layout h-full min-h-0 overflow-auto">
      <div className={`${STORY_PANEL_CLASS} flex min-h-64 flex-col overflow-hidden`}>
        <StorySectionHeader
          title="Git commits"
          meta={`${versions.length} 个提交`}
          action={
            <Button
              size="xs"
              shape="square"
              variant="ghost"
              aria-label="刷新版本历史"
              disabled={loading}
              icon={<ArrowClockwiseIcon size={11} className={loading ? "animate-spin" : ""} />}
              onClick={refresh}
            />
          }
        />
        <VirtualList
          items={versions}
          getItemKey={(version) => version.sha}
          estimateSize={() => 66}
          overscan={10}
          aria-label="Git 提交历史"
          aria-busy={loading}
          className="min-h-52 flex-1"
          emptyState={<StoryEmpty label={loading ? "正在读取提交历史…" : "暂无提交历史"} />}
          renderItem={(version) => {
            const current = version.sha === workspace.baseCommitSha;
            const active = selection?.kind === "commit" && selection.version.sha === version.sha;
            return (
              <button
                type="button"
                className={`grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] gap-2 border-b border-kumo-line px-2 py-2 text-left hover:bg-kumo-hover ${active ? "bg-kumo-tint" : "bg-kumo-base"}`}
                onClick={() => void viewVersion(version)}
              >
                <span className={`mt-1 size-2 rounded-full border ${current ? "border-kumo-accent bg-kumo-accent" : "border-kumo-line bg-kumo-base"}`} />
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-medium text-kumo-default">{version.message}</span>
                  <span className="mt-1 block truncate font-mono text-[9px] text-kumo-subtle">
                    {version.author ?? "unknown"} · {formatDate(version.committedAt ?? version.createdAt)}
                  </span>
                </span>
                <span className="flex items-center gap-1 font-mono text-[9px] text-kumo-accent">
                  {viewingSha === version.sha && <SpinnerGapIcon size={10} className="animate-spin" />}
                  {version.shortSha ?? shortSha(version.sha)}
                </span>
              </button>
            );
          }}
        />
        {nextCursor && (
          <button
            type="button"
            disabled={loadingMore}
            className="shrink-0 border-t border-kumo-line bg-kumo-elevated py-2 font-mono text-[10px] text-kumo-accent hover:bg-kumo-hover disabled:opacity-40"
            onClick={() => void loadMore()}
          >
            {loadingMore ? "正在加载…" : "加载更早版本"}
          </button>
        )}
      </div>

      <div className={`${STORY_PANEL_CLASS} flex min-h-64 flex-col overflow-hidden`}>
        <StorySectionHeader title="工作区 revision 留痕" meta={`${events.length} 条事件`} />
        <VirtualList
          items={events}
          getItemKey={(event) => event.id}
          estimateSize={() => 72}
          overscan={12}
          aria-label="工作区 revision 历史"
          aria-busy={loading}
          className="min-h-52 flex-1"
          emptyState={<StoryEmpty label={loading ? "正在读取工作区留痕…" : "暂无工作区事件"} />}
          renderItem={(event) => {
            const active = selection?.kind === "event" && selection.event.id === event.id;
            return (
              <button
                type="button"
                className={`w-full border-b border-kumo-line px-2 py-2 text-left hover:bg-kumo-hover ${active ? "bg-kumo-tint" : "bg-kumo-base"}`}
                onClick={() => {
                  versionSequence.current += 1;
                  setViewingSha(null);
                  setSelection({ kind: "event", event });
                }}
              >
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">rev {event.revision}</Badge>
                  <span className="truncate text-[11px] font-medium text-kumo-default">
                    {event.summary || eventKindLabel(event.kind)}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-kumo-inactive">
                    {formatDate(event.createdAt)}
                  </span>
                </span>
                <span className="mt-1 block truncate font-mono text-[9px] text-kumo-subtle">
                  {event.actor} · {event.source}
                  {event.baseCommitSha ? ` · ${shortSha(event.baseCommitSha)}` : ""}
                  {event.restoredFromSha ? ` · from ${shortSha(event.restoredFromSha)}` : ""}
                  {event.restoredFromEventId ? ` · from event #${event.restoredFromEventId}` : ""}
                </span>
              </button>
            );
          }}
        />
        {nextEventBeforeId && (
          <button
            type="button"
            disabled={loadingMoreEvents}
            className="shrink-0 border-t border-kumo-line bg-kumo-elevated py-2 font-mono text-[10px] text-kumo-accent hover:bg-kumo-hover disabled:opacity-40"
            onClick={() => void loadMoreEvents()}
          >
            {loadingMoreEvents ? "正在加载…" : "加载更早 revision"}
          </button>
        )}
      </div>

      <div className={`${STORY_PANEL_CLASS} story-history-preview flex min-h-72 flex-col overflow-hidden`}>
        <StorySectionHeader
          title={selectionTitle(selection)}
          meta={selection?.kind === "event" ? `${eventDiffTotal(selection.event)} 项变更` : selection?.version.message}
        />
        {selection ? (
          <>
            <div className="min-h-40 flex-1 overflow-auto bg-kumo-elevated p-3">
              {selectedStory ? (
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-kumo-subtle">
                  {JSON.stringify(selectedStory, null, 2)}
                </pre>
              ) : (
                <div className="flex h-full items-center justify-center font-mono text-[10px] text-kumo-inactive">
                  该旧事件没有保存快照；仍可查看 actor、summary 与 Diff 统计
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-base p-3">
              <span className="font-mono text-[10px] text-kumo-subtle">
                恢复只写入工作区，确认 Git commit 仍需底部提交操作
              </span>
              <Button
                size="sm"
                variant="secondary"
                icon={<ClockCounterClockwiseIcon size={12} />}
                disabled={disabled || (!selectedStory && selection.kind === "event")}
                onClick={() => {
                  if (selection.kind === "commit") {
                    onRequestRestore({
                      kind: "commit",
                      sha: selection.version.sha,
                      label: `${shortSha(selection.version.sha)} ${selection.version.message}`
                    });
                  } else if (selection.event.afterStory) {
                    onRequestRestore({
                      kind: "event",
                      eventId: selection.event.id,
                      revision: selection.event.revision,
                      label: selection.event.summary || `rev ${selection.event.revision}`
                    });
                  }
                }}
              >
                恢复到工作区
              </Button>
            </div>
          </>
        ) : (
          <div className="flex min-h-52 flex-1 items-center justify-center font-mono text-[10px] text-kumo-inactive">
            从 Git commit 或工作区 revision 选择一个版本
          </div>
        )}

        <form className="shrink-0 border-t border-kumo-line bg-kumo-elevated p-3" onSubmit={createPullRequest}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold text-kumo-default">
              <GitPullRequestIcon size={13} className="text-kumo-success" />
              {workspace.branch} → {workspace.mainBranch ?? "main"}
            </span>
            {pullRequest && (
              <a href={pullRequest.htmlUrl ?? pullRequest.url} target="_blank" rel="noreferrer" className="font-mono text-[10px] text-kumo-success hover:underline">
                PR #{pullRequest.number} ↗
              </a>
            )}
          </div>
          {!pullRequest && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <input className={STORY_INPUT_CLASS} value={prTitle} disabled={disabled || workspace.dirty} aria-label="Pull Request 标题" onChange={(event) => setPrTitle(event.target.value)} />
              <Button type="submit" size="sm" variant="primary" disabled={disabled || workspace.dirty || !prTitle.trim()} icon={<GitCommitIcon size={11} />}>
                创建 PR
              </Button>
              <textarea className={`${STORY_INPUT_CLASS} col-span-2 min-h-14 resize-none`} value={prBody} disabled={disabled || workspace.dirty} aria-label="Pull Request 描述" placeholder="可选：说明本次正式版变更" onChange={(event) => setPrBody(event.target.value)} />
              {workspace.dirty && <span className="col-span-2 font-mono text-[9px] text-kumo-warning">请先确认并提交当前工作区</span>}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

function selectionTitle(selection: HistorySelection | null): string {
  if (!selection) return "版本查看器";
  return selection.kind === "commit"
    ? `Git ${shortSha(selection.version.sha)}`
    : `工作区 rev ${selection.event.revision}`;
}

function eventKindLabel(kind: StoryWorkspaceEvent["kind"]): string {
  return {
    initialize: "初始化工作区",
    update: "更新工作区",
    discard: "放弃未提交修改",
    restore: "恢复历史版本",
    commit: "确认 Git 提交",
    sync: "同步远端分支"
  }[kind];
}

function eventDiffTotal(event: StoryWorkspaceEvent): number {
  const diff = event.diff as unknown as {
    items?: unknown[];
    business?: { summary?: { total?: number } };
  } | undefined;
  return diff?.items?.length ?? diff?.business?.summary?.total ?? 0;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatDate(value?: string | number): string {
  if (value === undefined) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
