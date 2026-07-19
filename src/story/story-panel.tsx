import {
  ArrowClockwiseIcon,
  BracketsCurlyIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  GitBranchIcon,
  GitCommitIcon,
  ListBulletsIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode
} from "react";
import {
  StoryApiError,
  commitStoryWorkspace,
  discardStoryWorkspace,
  fetchStoryWorkspace,
  restoreStoryEvent,
  restoreStoryVersion,
  syncStoryWorkspace,
  updateStoryLayout,
  updateStoryWorkspace
} from "./api";
import { DesignView } from "./design-view";
import { FormView } from "./form-view";
import { HistoryView, type StoryRestoreRequest } from "./history-view";
import { JsonView } from "./json-view";
import { StoryEditorDialog } from "./story-editor-dialog";
import {
  deleteStoryTarget,
  storyTargetLabel,
  storyTargetSource
} from "./story-operations";
import {
  MysteryStoryDslSchema,
  type MysteryStoryDsl,
  type StoryLayout,
  type StoryWorkspace
} from "./types";
import {
  storyEditorTargetId,
  type StoryEditorTarget
} from "./ui-model";
import {
  StoryConfirmDialog,
  STORY_INPUT_CLASS
} from "./story-ui";

type StoryTab = "design" | "form" | "json" | "history";
type WorkspaceSource =
  | "relationship-panel"
  | "timeline-panel"
  | "json-editor";

type ConfirmAction =
  | { kind: "discard" }
  | { kind: "commit" }
  | { kind: "sync" }
  | { kind: "delete"; target: StoryEditorTarget }
  | { kind: "restore"; request: StoryRestoreRequest };

const TABS: Array<{ id: StoryTab; label: string; icon: ReactNode }> = [
  { id: "design", label: "设计", icon: <GitBranchIcon size={13} /> },
  { id: "form", label: "表单", icon: <ListBulletsIcon size={13} /> },
  { id: "json", label: "JSON", icon: <BracketsCurlyIcon size={13} /> },
  {
    id: "history",
    label: "历史",
    icon: <ClockCounterClockwiseIcon size={13} />
  }
];

export interface StoryPanelProps {
  revision: number;
  onClose: () => void;
  onWorkspaceRevision?: (revision: number) => void;
}

/** Shared server-backed story working tree with explicit human Git commits. */
export function StoryPanel({
  revision,
  onClose,
  onWorkspaceRevision
}: StoryPanelProps) {
  const [activeTab, setActiveTab] = useState<StoryTab>("design");
  const [workspace, setWorkspace] = useState<StoryWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [editorTarget, setEditorTarget] = useState<StoryEditorTarget | null>(null);

  const acceptWorkspace = useCallback(
    (next: StoryWorkspace) => {
      setWorkspace(next);
      onWorkspaceRevision?.(next.revision);
    },
    [onWorkspaceRevision]
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const next = await fetchStoryWorkspace(signal);
        acceptWorkspace(next);
      } catch (refreshError) {
        if (signal?.aborted) return;
        setError(`读取剧本工作区失败：${errorMessage(refreshError)}`);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [acceptWorkspace]
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, revision]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleFailure = useCallback(
    (action: string, actionError: unknown) => {
      if (actionError instanceof StoryApiError && actionError.status === 409) {
        if (actionError.currentWorkspace) {
          acceptWorkspace(actionError.currentWorkspace);
        } else {
          void refresh();
        }
        setError(
          `${action}未执行：工作区已被其他页面或 Agent 更新，已加载最新 revision。请检查后重试。`
        );
        return;
      }
      setError(`${action}失败：${errorMessage(actionError)}`);
    },
    [acceptWorkspace, refresh]
  );

  const saveStory = useCallback(
    async (
      story: MysteryStoryDsl,
      source: WorkspaceSource,
      summary: string
    ): Promise<StoryWorkspace | null> => {
      if (!workspace || busy) return null;
      const validation = MysteryStoryDslSchema.safeParse(story);
      if (!validation.success) {
        setError(
          `剧本结构无效：${validation.error.issues
            .slice(0, 6)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("；")}`
        );
        return null;
      }
      setBusy(true);
      setError(null);
      try {
        const next = await updateStoryWorkspace({
          story: validation.data,
          expectedRevision: workspace.revision,
          source,
          summary
        });
        acceptWorkspace(next);
        setNotice("修改已保存到共享工作区，尚未提交 GitHub");
        return next;
      } catch (saveError) {
        handleFailure("保存工作区", saveError);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [acceptWorkspace, busy, handleFailure, workspace]
  );

  const saveLayout = useCallback(
    async (layout: StoryLayout, summary: string): Promise<boolean> => {
      if (!workspace || busy) return false;
      setBusy(true);
      setError(null);
      try {
        const next = await updateStoryLayout({
          layout,
          expectedRevision: workspace.revision,
          source: "design-layout",
          summary
        });
        acceptWorkspace(next);
        setNotice("节点布局已保存到共享工作区，尚未提交 GitHub");
        return true;
      } catch (saveError) {
        handleFailure("保存节点布局", saveError);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [acceptWorkspace, busy, handleFailure, workspace]
  );

  const executeConfirmation = async () => {
    if (!workspace || !confirmAction || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (confirmAction.kind === "discard") {
        const next = await discardStoryWorkspace(workspace.revision);
        acceptWorkspace(next);
        setNotice("未提交修改已全部放弃");
      } else if (confirmAction.kind === "commit") {
        const message = commitMessage.trim();
        if (!message) throw new Error("提交说明不能为空");
        const result = await commitStoryWorkspace({
          message,
          expectedRevision: workspace.revision
        });
        acceptWorkspace(result.workspace);
        setCommitMessage("");
        setNotice(
          result.commit
            ? `已提交 ${shortSha(result.commit.sha)} 到 ${result.workspace.branch}`
            : `工作区已与 ${result.workspace.branch} 同步`
        );
      } else if (confirmAction.kind === "sync") {
        const next = await syncStoryWorkspace(workspace.revision);
        acceptWorkspace(next);
        setActiveTab("design");
        setNotice("远端分支已同步到工作区，请在设计画板检查合并后的 Diff");
      } else if (confirmAction.kind === "delete") {
        const target = confirmAction.target;
        const nextStory = deleteStoryTarget(workspace.story, target);
        const next = await updateStoryWorkspace({
          story: nextStory,
          expectedRevision: workspace.revision,
          source: storyTargetSource(target),
          summary: `删除 ${storyTargetLabel(workspace, target)}`
        });
        acceptWorkspace(next);
        setEditorTarget(null);
        setNotice("删除已写入工作区，请在设计视图检查 Diff");
      } else if (confirmAction.request.kind === "commit") {
        const next = await restoreStoryVersion({
          sha: confirmAction.request.sha,
          expectedRevision: workspace.revision
        });
        acceptWorkspace(next);
        setActiveTab("design");
        setNotice("Git 历史版本已恢复到工作区，Diff 已叠加到设计视图");
      } else {
        const next = await restoreStoryEvent({
          eventId: confirmAction.request.eventId,
          expectedRevision: workspace.revision
        });
        acceptWorkspace(next);
        setActiveTab("design");
        setNotice("工作区 revision 已恢复，Diff 已叠加到设计视图");
      }
      setConfirmAction(null);
    } catch (confirmationError) {
      handleFailure(confirmActionLabel(confirmAction), confirmationError);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !workspace) {
    return (
      <Surface className="flex h-full min-h-80 w-full items-center justify-center !rounded-none bg-kumo-base text-kumo-default">
        <div className="flex items-center gap-2 font-mono text-xs text-kumo-subtle">
          <SpinnerGapIcon size={16} className="animate-spin text-kumo-brand" />
          正在同步 GitHub 工作区…
        </div>
      </Surface>
    );
  }

  const dialog = workspace && confirmAction
    ? confirmationCopy(workspace, confirmAction, commitMessage)
    : null;

  return (
    <Surface className="story-workbench flex h-full min-h-[30rem] w-full min-w-0 flex-col overflow-hidden !rounded-none bg-kumo-base font-sans text-kumo-default">
      <StoryStatusHeader
        workspace={workspace}
        busy={busy}
        onSync={() => setConfirmAction({ kind: "sync" })}
        onClose={onClose}
      />

      <nav
        aria-label="剧本工作台视图"
        className="flex shrink-0 overflow-x-auto border-b border-kumo-line bg-kumo-elevated px-2"
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={active ? "page" : undefined}
              className={`flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 font-mono text-[11px] transition-colors ${
                active
                  ? "border-kumo-brand bg-kumo-tint text-kumo-default"
                  : "border-transparent text-kumo-subtle hover:bg-kumo-fill-hover hover:text-kumo-default"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              {tab.label}
              {(tab.id === "design" || tab.id === "form") && workspace?.dirty && (
                <span className="rounded-sm bg-kumo-warning/15 px-1 text-[9px] text-kumo-warning">
                  {workspaceChangeCount(workspace)}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {(error || notice) && (
        <div
          role={error ? "alert" : "status"}
          className={`mx-3 mt-2 flex shrink-0 items-start gap-2 rounded-md border px-2.5 py-2 font-mono text-[11px] ${
            error
              ? "border-kumo-danger/35 bg-kumo-danger/10 text-kumo-danger"
              : "border-kumo-success/35 bg-kumo-success/10 text-kumo-success"
          }`}
        >
          {error ? <WarningCircleIcon size={14} /> : <CheckIcon size={14} />}
          <span className="min-w-0 flex-1">{error ?? notice}</span>
          <button
            type="button"
            aria-label="关闭提示"
            className="shrink-0 opacity-70 hover:opacity-100"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >
            <XIcon size={12} />
          </button>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-hidden p-3">
        {!workspace ? (
          <EmptyWorkspace onRetry={() => void refresh()} />
        ) : activeTab === "design" ? (
          <DesignView
            workspace={workspace}
            disabled={busy}
            onEdit={setEditorTarget}
            onLayoutChange={saveLayout}
          />
        ) : activeTab === "form" ? (
          <FormView workspace={workspace} disabled={busy} onEdit={setEditorTarget} />
        ) : activeTab === "json" ? (
          <JsonView workspace={workspace} disabled={busy} onSave={saveStory} />
        ) : (
          <HistoryView
            workspace={workspace}
            disabled={busy}
            onError={setError}
            onNotice={setNotice}
            onRequestRestore={(request) =>
              setConfirmAction({ kind: "restore", request })
            }
          />
        )}
      </main>

      {workspace && (
        <CommitBar
          workspace={workspace}
          message={commitMessage}
          busy={busy}
          onMessage={setCommitMessage}
          onDiscard={() => setConfirmAction({ kind: "discard" })}
          onCommit={() => {
            setActiveTab("design");
            setConfirmAction({ kind: "commit" });
          }}
        />
      )}

      {workspace && editorTarget && (
        <StoryEditorDialog
          key={storyEditorTargetId(editorTarget)}
          target={editorTarget}
          workspace={workspace}
          disabled={busy}
          onClose={() => setEditorTarget(null)}
          onSave={saveStory}
          onRequestDelete={(target) =>
            setConfirmAction({ kind: "delete", target })
          }
        />
      )}

      {dialog && (
        <StoryConfirmDialog
          open
          title={dialog.title}
          description={dialog.description}
          confirmLabel={dialog.confirmLabel}
          destructive={dialog.destructive}
          busy={busy}
          details={dialog.details}
          onOpenChange={(open) => {
            if (!open && !busy) setConfirmAction(null);
          }}
          onConfirm={() => void executeConfirmation()}
        />
      )}
    </Surface>
  );
}

function StoryStatusHeader({
  workspace,
  busy,
  onSync,
  onClose
}: {
  workspace: StoryWorkspace | null;
  busy: boolean;
  onSync: () => void;
  onClose: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-base px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-kumo-brand/30 bg-kumo-brand/10 text-kumo-brand">
          <GitBranchIcon size={15} weight="bold" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-kumo-default">
              <Text size="sm" bold>剧本工作台</Text>
            </span>
            {workspace && (
              <span
                className={`size-1.5 shrink-0 rounded-full ${workspace.dirty ? "bg-kumo-warning" : "bg-kumo-success"}`}
                title={workspace.dirty ? "有未提交修改" : "工作区干净"}
              />
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[10px] text-kumo-subtle">
            <span className="truncate text-kumo-brand">{workspace?.branch ?? "连接中"}</span>
            <span>·</span>
            <span title={workspace?.baseCommitSha}>{workspace ? shortSha(workspace.baseCommitSha) : "-------"}</span>
            <span>·</span>
            <span>rev {workspace?.revision ?? "-"}</span>
          </div>
        </div>
      </div>
      {workspace && (
        <div className="hidden items-center gap-1.5 sm:flex">
          <StatusChip label="正式" value={workspace.mainBranch ?? "main"} />
          <StatusChip label="工作区" value={workspace.dirty ? "未提交" : "已同步"} tone={workspace.dirty ? "warning" : "success"} />
          {workspace.modifiedBy && <StatusChip label="修改者" value={workspace.modifiedBy} />}
          {workspace.restoredFromSha && <StatusChip label="恢复自" value={shortSha(workspace.restoredFromSha)} />}
          {workspace.restoredFromEventId && <StatusChip label="恢复自" value={`event #${workspace.restoredFromEventId}`} />}
        </div>
      )}
      {workspace && (
        <Button
          variant="ghost"
          size="sm"
          aria-label="同步远端草稿分支"
          disabled={busy}
          icon={<ArrowClockwiseIcon size={12} />}
          onClick={onSync}
        >
          <span className="hidden lg:inline">同步</span>
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        aria-label="关闭剧本工作台"
        icon={<XIcon size={14} />}
        onClick={onClose}
      />
    </header>
  );
}

function StatusChip({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: string;
  tone?: "default" | "warning" | "success";
}) {
  const toneClass =
    tone === "warning"
      ? "border-kumo-warning/35 text-kumo-warning"
      : tone === "success"
        ? "border-kumo-success/35 text-kumo-success"
        : "border-kumo-line text-kumo-subtle";
  return (
    <span className={`max-w-40 truncate rounded border bg-kumo-elevated px-1.5 py-1 font-mono text-[9px] ${toneClass}`} title={`${label}: ${value}`}>
      <span className="text-kumo-subtle">{label}/</span>{value}
    </span>
  );
}

function CommitBar({
  workspace,
  message,
  busy,
  onMessage,
  onDiscard,
  onCommit
}: {
  workspace: StoryWorkspace;
  message: string;
  busy: boolean;
  onMessage: (message: string) => void;
  onDiscard: () => void;
  onCommit: () => void;
}) {
  return (
    <footer className="shrink-0 border-t border-kumo-line bg-kumo-base px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-36 items-center gap-1.5 font-mono text-[10px]">
          <span className={`size-1.5 rounded-full ${workspace.dirty ? "bg-kumo-warning" : "bg-kumo-success"}`} />
          <span className={workspace.dirty ? "text-kumo-warning" : "text-kumo-success"}>
            {workspace.dirty ? `${workspaceChangeCount(workspace)} 项未提交变更` : "工作区干净"}
          </span>
        </div>
        <input
          value={message}
          disabled={!workspace.dirty || busy}
          aria-label="Git 提交说明"
          placeholder="提交说明，例如：补充仓库搜查线索"
          className={`${STORY_INPUT_CLASS} min-w-56 flex-1`}
          onChange={(event) => onMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && message.trim() && workspace.dirty) {
              event.preventDefault();
              onCommit();
            }
          }}
        />
        <Button size="sm" variant="secondary-destructive" disabled={!workspace.dirty || busy} onClick={onDiscard}>
          放弃修改
        </Button>
        <Button size="sm" variant="primary" disabled={!workspace.dirty || !message.trim() || busy} icon={<GitCommitIcon size={12} />} onClick={onCommit}>
          检查并批量提交
        </Button>
      </div>
    </footer>
  );
}

function confirmationCopy(
  workspace: StoryWorkspace,
  action: ConfirmAction,
  commitMessage: string
): {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  details?: ReactNode;
} {
  if (action.kind === "discard") {
    return {
      title: "放弃全部未提交修改？",
      description: `工作区将恢复到 ${workspace.branch} 的当前 HEAD。工作区 revision 留痕仍会保留。`,
      confirmLabel: "放弃修改",
      destructive: true,
      details: `${workspaceChangeCount(workspace)} 项业务与布局变更将从当前工作区移除`
    };
  }
  if (action.kind === "commit") {
    return {
      title: "确认创建 Git commit？",
      description: "设计视图已经叠加展示本次 Diff。确认后会在个人草稿分支产生永久 Git 记录。",
      confirmLabel: "确认提交",
      details: (
        <div className="space-y-1">
          <div>{workspace.branch} · {workspaceChangeCount(workspace)} 项累计变更</div>
          <div className="text-kumo-default">{commitMessage.trim()}</div>
        </div>
      )
    };
  }
  if (action.kind === "sync") {
    return {
      title: "同步远端草稿分支？",
      description: "系统会读取 GitHub 草稿分支的最新 HEAD，并与当前工作区做三方合并。若存在冲突，同步会停止并保留当前内容。",
      confirmLabel: "同步并检查",
      destructive: false,
      details: workspace.remoteHeadSha
        ? `${workspace.branch} · 远端 ${shortSha(workspace.remoteHeadSha)}`
        : workspace.branch
    };
  }
  if (action.kind === "delete") {
    return {
      title: `删除${action.target.kind === "person" ? "人物" : action.target.kind === "bond" ? "关系" : "事件"}？`,
      description: "删除只写入未提交工作区，并在设计视图以红色 Diff 标记；之后仍需单独确认 Git commit。",
      confirmLabel: "确认删除",
      destructive: true,
      details: storyTargetLabel(workspace, action.target)
    };
  }
  return {
    title: "恢复这个历史版本？",
    description: "当前未提交工作区会被该历史快照替换；Git 分支不会移动。恢复后会自动返回设计视图展示 Diff。",
    confirmLabel: "恢复到工作区",
    destructive: workspace.dirty,
    details: action.request.label
  };
}

function confirmActionLabel(action: ConfirmAction): string {
  if (action.kind === "discard") return "放弃修改";
  if (action.kind === "commit") return "提交版本";
  if (action.kind === "sync") return "同步远端分支";
  if (action.kind === "delete") return "删除实体";
  return "恢复历史版本";
}

function EmptyWorkspace({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-kumo-line bg-kumo-base">
      <WarningCircleIcon size={24} className="text-kumo-warning" />
      <div className="font-mono text-xs text-kumo-subtle">剧本工作区不可用</div>
      <Button size="sm" variant="secondary" onClick={onRetry}>重新连接</Button>
    </div>
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function workspaceChangeCount(workspace: StoryWorkspace): number {
  return workspace.diff.items.length + workspace.layoutDiff.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
