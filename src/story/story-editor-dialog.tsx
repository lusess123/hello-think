import { TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button, Dialog } from "@cloudflare/kumo";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MysteryStoryDsl, StoryWorkspace } from "./types";
import {
  applyStoryEntity,
  storyEntityForTarget,
  storyTargetExists,
  storyTargetLabel,
  storyTargetSource
} from "./story-operations";
import {
  adoptRemoteDraft,
  createLocalDraft,
  editLocalDraft,
  keepLocalDraft,
  receiveRemoteDraft,
  type StoryEditorTarget
} from "./ui-model";
import {
  StoryConflictBanner,
  StoryConfirmDialog,
  STORY_INPUT_CLASS,
  STORY_LABEL_CLASS
} from "./story-ui";

export function StoryEditorDialog({
  target,
  workspace,
  disabled,
  onClose,
  onSave,
  onRequestDelete
}: {
  target: StoryEditorTarget;
  workspace: StoryWorkspace;
  disabled: boolean;
  onClose: () => void;
  onSave: (
    story: MysteryStoryDsl,
    source: "relationship-panel" | "timeline-panel",
    summary: string
  ) => Promise<StoryWorkspace | null>;
  onRequestDelete: (target: StoryEditorTarget) => void;
}) {
  const remoteEntity = useMemo(
    () => storyEntityForTarget(workspace, target),
    [target, workspace]
  );
  const remoteText = useMemo(
    () => JSON.stringify(remoteEntity, null, 2),
    [remoteEntity]
  );
  const [draft, setDraft] = useState(() =>
    createLocalDraft(remoteText, workspace.revision)
  );
  const [error, setError] = useState<string | null>(null);
  const [closeWarning, setCloseWarning] = useState(false);

  useEffect(() => {
    setDraft((current) =>
      receiveRemoteDraft(current, remoteText, workspace.revision)
    );
  }, [remoteText, workspace.revision]);

  const parsed = useMemo(() => parseRecord(draft.value), [draft.value]);
  const entityExists = storyTargetExists(workspace.story, target);
  const isNew = target.kind !== "opening" && target.key === null;
  const removedSnapshot =
    target.kind !== "opening" && target.key !== null && !entityExists;
  const entityType =
    target.kind === "opening"
      ? "开场入口"
      : target.kind === "person"
        ? "人物"
        : target.kind === "bond"
          ? "人物关系"
          : "剧情节点";
  const title = `${removedSnapshot ? "查看已删除" : isNew ? "新增" : "编辑"}${entityType}`;

  const setField = (field: string, value: unknown, removeWhenEmpty = false) => {
    const current = parseRecord(draft.value);
    if (!current) {
      setError("请先修复实体 JSON 格式，再使用快捷字段");
      return;
    }
    if (removeWhenEmpty && value === "") delete current[field];
    else current[field] = value;
    setDraft((state) =>
      editLocalDraft(state, JSON.stringify(current, null, 2))
    );
    setError(null);
  };

  const save = async () => {
    let value: unknown;
    try {
      value = JSON.parse(draft.value);
      const next = applyStoryEntity(workspace.story, target, value);
      const result = await onSave(
        next,
        storyTargetSource(target),
        `${removedSnapshot ? "恢复" : isNew ? "新增" : "修改"}${storyTargetLabel(workspace, target)}`
      );
      if (result) onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };

  const requestClose = (open: boolean) => {
    if (open) return;
    if (draft.dirty) setCloseWarning(true);
    else onClose();
  };

  return (
    <>
      <Dialog.Root open onOpenChange={requestClose}>
        <Dialog size="lg" className="max-h-[min(46rem,90vh)] overflow-hidden bg-kumo-base p-0 text-kumo-default">
          <div className="border-b border-kumo-line bg-kumo-elevated px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Description className="mt-0.5 font-mono text-[10px] text-kumo-subtle">
              {targetIdentifier(target)} · 基于 rev {workspace.revision} · 保存后进入未提交工作区
            </Dialog.Description>
          </div>

          {removedSnapshot && (
            <div className="border-b border-kumo-danger/30 bg-kumo-danger/10 px-4 py-2 font-mono text-[10px] leading-4 text-kumo-danger">
              这是基准版本中已删除实体的快照。下方内容仅用于核对；点击“恢复实体到工作区”才会重新加入当前剧本。
            </div>
          )}

          {draft.conflictRevision !== undefined && (
            <StoryConflictBanner
              revision={draft.conflictRevision}
              onAdoptRemote={() => {
                setDraft(adoptRemoteDraft(remoteText, workspace.revision));
                setError(null);
              }}
              onKeepLocal={() =>
                setDraft((current) =>
                  keepLocalDraft(current, workspace.revision)
                )
              }
            />
          )}

          {error && (
            <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-kumo-danger/35 bg-kumo-danger/10 px-2.5 py-2 text-xs text-kumo-danger">
              <WarningCircleIcon size={14} className="mt-px shrink-0" />
              {error}
            </div>
          )}

          <div className="max-h-[calc(min(46rem,90vh)-9rem)] overflow-auto p-4">
            {target.kind === "opening" ? (
              <OpeningQuickFields
                value={parsed}
                workspace={workspace}
                disabled={disabled}
                onField={setField}
              />
            ) : target.kind === "person" ? (
              <PersonQuickFields value={parsed} disabled={disabled} onField={setField} />
            ) : target.kind === "bond" ? (
              <BondQuickFields
                value={parsed}
                workspace={workspace}
                disabled={disabled}
                onField={setField}
              />
            ) : (
              <TimelineQuickFields
                value={parsed}
                workspace={workspace}
                disabled={disabled}
                onField={setField}
              />
            )}

            <label className="mt-3 block">
              <span className={STORY_LABEL_CLASS}>实体 JSON</span>
              <textarea
                value={draft.value}
                disabled={disabled}
                spellCheck={false}
                aria-label="实体 JSON"
                className={`${STORY_INPUT_CLASS} min-h-56 resize-y leading-5`}
                onChange={(event) => {
                  setDraft((current) =>
                    editLocalDraft(current, event.target.value)
                  );
                  setError(null);
                }}
              />
            </label>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-kumo-line bg-kumo-elevated px-4 py-3">
            <div>
              {entityExists && target.kind !== "opening" && (
                <Button
                  size="sm"
                  variant="secondary-destructive"
                  disabled={disabled}
                  icon={<TrashIcon size={12} />}
                  onClick={() => onRequestDelete(target)}
                >
                  删除
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => requestClose(false)}
              >
                取消
              </Button>
              <Button size="sm" variant="primary" disabled={disabled} onClick={() => void save()}>
                {removedSnapshot ? "恢复实体到工作区" : "写入工作区"}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <StoryConfirmDialog
        open={closeWarning}
        title="放弃尚未保存的输入？"
        description="这些内容还没有写入 Durable Object，关闭编辑窗后无法恢复。"
        confirmLabel="放弃输入"
        destructive
        onOpenChange={setCloseWarning}
        onConfirm={onClose}
      />
    </>
  );
}

function OpeningQuickFields({
  value,
  workspace,
  disabled,
  onField
}: {
  value: Record<string, unknown> | null;
  workspace: StoryWorkspace;
  disabled: boolean;
  onField: (field: string, value: unknown, removeWhenEmpty?: boolean) => void;
}) {
  const nodes = workspace.story.storyline.timeline.flatMap((node) => [
    { key: node.key, label: `${node.at} · ${node.key}` },
    ...(node.parallel?.map((event) => ({
      key: event.key,
      label: `${node.at} · ${event.key}（并行子事件）`
    })) ?? [])
  ]);
  return (
    <Field label="开场节点">
      <select
        className={STORY_INPUT_CLASS}
        value={stringValue(value?.opening)}
        disabled={disabled}
        onChange={(event) => onField("opening", event.target.value)}
      >
        {nodes.map((node) => (
          <option key={node.key} value={node.key}>{node.label}</option>
        ))}
      </select>
    </Field>
  );
}

function PersonQuickFields({
  value,
  disabled,
  onField
}: {
  value: Record<string, unknown> | null;
  disabled: boolean;
  onField: (field: string, value: unknown, removeWhenEmpty?: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <Field label="Key">
        <input className={STORY_INPUT_CLASS} value={stringValue(value?.key)} disabled={disabled} onChange={(event) => onField("key", event.target.value)} />
      </Field>
      <Field label="姓名">
        <input className={STORY_INPUT_CLASS} value={stringValue(value?.name)} disabled={disabled} onChange={(event) => onField("name", event.target.value)} />
      </Field>
      <Field label="身份" className="sm:col-span-2">
        <input className={STORY_INPUT_CLASS} value={stringValue(value?.identity)} disabled={disabled} onChange={(event) => onField("identity", event.target.value)} />
      </Field>
    </div>
  );
}

function BondQuickFields({
  value,
  workspace,
  disabled,
  onField
}: {
  value: Record<string, unknown> | null;
  workspace: StoryWorkspace;
  disabled: boolean;
  onField: (field: string, value: unknown, removeWhenEmpty?: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Field label="源人物">
        <select className={STORY_INPUT_CLASS} value={stringValue(value?.source)} disabled={disabled} onChange={(event) => onField("source", event.target.value)}>
          {workspace.story.cast.map((person) => <option key={person.key} value={person.key}>{person.name}</option>)}
        </select>
      </Field>
      <Field label="关系">
        <select className={STORY_INPUT_CLASS} value={stringValue(value?.relation)} disabled={disabled} onChange={(event) => onField("relation", event.target.value)}>
          <option value="sibling">手足</option>
          <option value="business_partner">商业伙伴</option>
          <option value="friend">朋友</option>
          <option value="rival">对手</option>
        </select>
      </Field>
      <Field label="目标人物">
        <select className={STORY_INPUT_CLASS} value={stringValue(value?.target)} disabled={disabled} onChange={(event) => onField("target", event.target.value)}>
          {workspace.story.cast.map((person) => <option key={person.key} value={person.key}>{person.name}</option>)}
        </select>
      </Field>
    </div>
  );
}

function TimelineQuickFields({
  value,
  workspace,
  disabled,
  onField
}: {
  value: Record<string, unknown> | null;
  workspace: StoryWorkspace;
  disabled: boolean;
  onField: (field: string, value: unknown, removeWhenEmpty?: boolean) => void;
}) {
  const parallel = Array.isArray(value?.parallel);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <Field label="Key">
        <input className={STORY_INPUT_CLASS} value={stringValue(value?.key)} disabled={disabled} onChange={(event) => onField("key", event.target.value)} />
      </Field>
      <Field label="时间">
        <input type="time" className={STORY_INPUT_CLASS} value={stringValue(value?.at)} disabled={disabled} onChange={(event) => onField("at", event.target.value)} />
      </Field>
      <Field label="主要人物">
        <select className={STORY_INPUT_CLASS} value={stringValue(value?.actor)} disabled={disabled || parallel} onChange={(event) => onField("actor", event.target.value, true)}>
          <option value="">未指定</option>
          {workspace.story.cast.map((person) => <option key={person.key} value={person.key}>{person.name}</option>)}
        </select>
      </Field>
      <Field label="事件摘要">
        <input className={STORY_INPUT_CLASS} value={stringValue(value?.event)} disabled={disabled || parallel} onChange={(event) => onField("event", event.target.value, true)} placeholder={parallel ? "并行容器通过 JSON 编辑" : "发生了什么"} />
      </Field>
    </div>
  );
}

function Field({
  label,
  className,
  children
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={className}>
      <span className={STORY_LABEL_CLASS}>{label}</span>
      {children}
    </label>
  );
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetIdentifier(target: StoryEditorTarget): string {
  if (target.kind === "opening") return "storyline.opening";
  return target.key ?? "新实体";
}
