import { WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { ProductConfirmDialog } from "../components/product-dialog";
import type { StoryDiffAction } from "./types";

export const STORY_INPUT_CLASS =
  "w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 font-mono text-xs text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-accent focus:ring-1 focus:ring-kumo-accent/30 disabled:cursor-not-allowed disabled:opacity-50";

export const STORY_LABEL_CLASS =
  "mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-kumo-subtle";

export const STORY_PANEL_CLASS =
  "rounded-lg border border-kumo-line bg-kumo-base";

export function StorySectionHeader({
  title,
  meta,
  action
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-elevated px-3">
      <h2 className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-kumo-default">
        {title}
      </h2>
      <div className="flex min-w-0 items-center gap-2">
        {meta && (
          <span className="max-w-64 truncate font-mono text-[9px] text-kumo-inactive">
            {meta}
          </span>
        )}
        {action}
      </div>
    </div>
  );
}

export function StoryEmpty({ label }: { label: string }) {
  return (
    <div className="p-5 text-center font-mono text-[10px] text-kumo-inactive">
      {label}
    </div>
  );
}

export function StoryConflictBanner({
  revision,
  onAdoptRemote,
  onKeepLocal
}: {
  revision: number;
  onAdoptRemote: () => void;
  onKeepLocal: () => void;
}) {
  return (
    <div
      role="alert"
      className="m-3 flex flex-wrap items-center gap-2 rounded-md border border-kumo-warning/35 bg-kumo-warning/10 px-2.5 py-2 text-kumo-warning"
    >
      <WarningCircleIcon size={14} className="shrink-0" />
      <div className="min-w-48 flex-1 font-mono text-[10px] leading-4">
        工作区已更新到 rev {revision}。你的未保存输入仍被保留，请选择如何继续。
      </div>
      <Button size="xs" variant="ghost" onClick={onAdoptRemote}>
        采用最新
      </Button>
      <Button size="xs" variant="secondary" onClick={onKeepLocal}>
        保留本地
      </Button>
    </div>
  );
}

export function StoryConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  details,
  onOpenChange,
  onConfirm
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  details?: ReactNode;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ProductConfirmDialog
      open={open}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      destructive={destructive}
      busy={busy}
      details={details}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );
}

export function StoryDiffBadge({
  action,
  fields = []
}: {
  action: StoryDiffAction;
  fields?: string[];
}) {
  const label =
    action === "added" ? "新增" : action === "removed" ? "删除" : "修改";
  const tone =
    action === "added"
      ? "border-kumo-success/40 bg-kumo-success/10 text-kumo-success"
      : action === "removed"
        ? "border-kumo-danger/40 bg-kumo-danger/10 text-kumo-danger"
        : "border-kumo-warning/40 bg-kumo-warning/10 text-kumo-warning";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[8px] ${tone}`}>
      {label}
      {fields.length > 0 && <span>· {fields.join(" / ")}</span>}
    </span>
  );
}

export function storyDiffSurface(action?: StoryDiffAction): string {
  if (action === "added") {
    return "border-kumo-success/60 bg-kumo-success/10";
  }
  if (action === "removed") {
    return "border-kumo-danger/60 bg-kumo-danger/10 opacity-75";
  }
  if (action === "modified") {
    return "border-kumo-warning/60 bg-kumo-warning/10";
  }
  return "border-kumo-line bg-kumo-base";
}
