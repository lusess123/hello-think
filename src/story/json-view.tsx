import {
  ArrowClockwiseIcon,
  BracketsCurlyIcon,
  CheckIcon,
  GitDiffIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";
import { VirtualList } from "../components/virtual-list";
import {
  parseStoryJson,
  type MysteryStoryDsl,
  type StoryJsonDiffLine,
  type StoryWorkspace
} from "./types";
import {
  adoptRemoteDraft,
  createLocalDraft,
  editLocalDraft,
  keepLocalDraft,
  receiveRemoteDraft
} from "./ui-model";
import {
  StoryConflictBanner,
  StoryEmpty,
  StorySectionHeader,
  STORY_PANEL_CLASS
} from "./story-ui";

export function JsonView({
  workspace,
  disabled,
  onSave
}: {
  workspace: StoryWorkspace;
  disabled: boolean;
  onSave: (
    story: MysteryStoryDsl,
    source: "json-editor",
    summary: string
  ) => Promise<StoryWorkspace | null>;
}) {
  const remoteText = useMemo(
    () => JSON.stringify(workspace.story, null, 2),
    [workspace.story]
  );
  const [draft, setDraft] = useState(() =>
    createLocalDraft(remoteText, workspace.revision)
  );
  const [mode, setMode] = useState<"editor" | "diff">("editor");

  useEffect(() => {
    setDraft((current) =>
      receiveRemoteDraft(current, remoteText, workspace.revision)
    );
  }, [remoteText, workspace.revision]);

  const validation = useMemo(() => parseStoryJson(draft.value), [draft.value]);

  const save = async () => {
    if (!validation.story) return;
    const next = await onSave(
      validation.story,
      "json-editor",
      "通过 JSON 编辑器更新剧本"
    );
    if (next) {
      setDraft(
        adoptRemoteDraft(JSON.stringify(next.story, null, 2), next.revision)
      );
    }
  };

  return (
    <section className={`${STORY_PANEL_CLASS} flex h-full min-h-0 flex-col overflow-hidden`}>
      <StorySectionHeader
        title="DSL / JSON"
        meta={`${draft.value.split("\n").length} 行 · ${formatBytes(new TextEncoder().encode(draft.value).length)}`}
        action={
          <div className="flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-base p-0.5">
            <ModeButton active={mode === "editor"} onClick={() => setMode("editor")} icon={<BracketsCurlyIcon size={10} />}>
              编辑
            </ModeButton>
            <ModeButton active={mode === "diff"} onClick={() => setMode("diff")} icon={<GitDiffIcon size={10} />}>
              行级 Diff
            </ModeButton>
          </div>
        }
      />

      {draft.conflictRevision !== undefined && (
        <StoryConflictBanner
          revision={draft.conflictRevision}
          onAdoptRemote={() =>
            setDraft(adoptRemoteDraft(remoteText, workspace.revision))
          }
          onKeepLocal={() =>
            setDraft((current) => keepLocalDraft(current, workspace.revision))
          }
        />
      )}

      {mode === "diff" ? (
        <VirtualList
          items={workspace.diff.jsonLines}
          getItemKey={(line, index) => `${index}:${jsonLineText(line)}`}
          estimateSize={() => 24}
          overscan={24}
          aria-label="JSON Diff 行"
          className="min-h-0 flex-1 bg-kumo-elevated font-mono"
          emptyState={<StoryEmpty label="当前没有 JSON Diff" />}
          renderItem={(line) => <JsonDiffRow line={line} />}
        />
      ) : (
        <div className="story-json-grid min-h-0 flex-1">
          <textarea
            value={draft.value}
            disabled={disabled}
            spellCheck={false}
            aria-label="剧本 JSON 编辑器"
            className="min-h-64 w-full resize-none border-0 bg-kumo-elevated p-3 font-mono text-xs leading-5 text-kumo-default outline-none focus:bg-kumo-base disabled:opacity-60"
            onChange={(event) =>
              setDraft((current) =>
                editLocalDraft(current, event.target.value)
              )
            }
          />
          <aside className="flex min-h-36 flex-col border-t border-kumo-line bg-kumo-base story-json-validation">
            <div
              className={`flex items-center gap-2 border-b border-kumo-line px-3 py-2 font-mono text-[10px] ${
                validation.story ? "text-kumo-success" : "text-kumo-danger"
              }`}
            >
              {validation.story ? <CheckIcon size={12} /> : <WarningCircleIcon size={12} />}
              {validation.story ? "Schema 校验通过" : `${validation.errors.length} 项错误`}
            </div>
            <VirtualList
              items={validation.errors}
              getItemKey={(item, index) => `${index}:${item}`}
              estimateSize={() => 52}
              overscan={6}
              aria-label="JSON 校验错误"
              className="min-h-0 flex-1"
              emptyState={
                <div className="p-3 font-mono text-[10px] leading-5 text-kumo-subtle">
                  数据满足悬疑故事 DSL。保存只写入 Durable Object 工作区，不创建 Git commit。
                </div>
              }
              renderItem={(item, index) => (
                <div className="border-b border-kumo-line px-3 py-2 font-mono text-[10px] leading-4 text-kumo-danger">
                  <span className="mr-1.5 text-kumo-subtle">{index + 1}.</span>
                  {item}
                </div>
              )}
            />
          </aside>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-base px-3 py-2">
        <span className="font-mono text-[10px] text-kumo-subtle">
          {mode === "diff"
            ? `${workspace.diff.jsonLines.length} 行变更`
            : validation.story
              ? draft.dirty
                ? "本地输入尚未写入工作区"
                : "编辑器与工作区一致"
              : "修复校验错误后才能写入"}
        </span>
        <div className="flex gap-2">
          {mode === "editor" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || !draft.dirty}
              icon={<ArrowClockwiseIcon size={11} />}
              onClick={() =>
                setDraft(adoptRemoteDraft(remoteText, workspace.revision))
              }
            >
              采用工作区
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={
              disabled ||
              mode !== "editor" ||
              !draft.dirty ||
              !validation.story ||
              draft.conflictRevision !== undefined
            }
            onClick={() => void save()}
          >
            保存到工作区
          </Button>
        </div>
      </div>
    </section>
  );
}

function ModeButton({
  active,
  icon,
  children,
  onClick
}: {
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex items-center gap-1 rounded px-2 py-1 font-mono text-[9px] ${
        active
          ? "bg-kumo-tint text-kumo-default"
          : "text-kumo-subtle hover:text-kumo-default"
      }`}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

function JsonDiffRow({ line }: { line: StoryJsonDiffLine }) {
  const action = line.type ?? line.action ?? "context";
  const content = jsonLineText(line);
  const prefix = action === "added" ? "+" : action === "removed" ? "−" : " ";
  const classes =
    action === "added"
      ? "border-l-kumo-success bg-kumo-success/10 text-kumo-success"
      : action === "removed"
        ? "border-l-kumo-danger bg-kumo-danger/10 text-kumo-danger"
        : "border-l-transparent text-kumo-subtle";
  return (
    <div className={`grid h-6 grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)] items-center border-l-2 px-2 text-[10px] ${classes}`}>
      <span className="text-right text-kumo-subtle">{line.oldLine ?? ""}</span>
      <span className="text-right text-kumo-subtle">{line.newLine ?? ""}</span>
      <span className="text-center">{prefix}</span>
      <code className="truncate whitespace-pre">{content}</code>
    </div>
  );
}

function jsonLineText(line: StoryJsonDiffLine): string {
  return line.content ?? line.line ?? "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
