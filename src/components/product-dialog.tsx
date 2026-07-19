import { Button, Dialog } from "@cloudflare/kumo";
import { type FormEvent, type ReactNode } from "react";
import { productDialogActionState } from "./product-dialog-model";

export interface ProductConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  details?: ReactNode;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/** Shared product confirmation surface used instead of native browser dialogs. */
export function ProductConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  details,
  error,
  onOpenChange,
  onConfirm
}: ProductConfirmDialogProps) {
  const actionState = productDialogActionState(busy);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
      <Dialog size="base" className="bg-kumo-base p-4 text-kumo-default">
        <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="mt-1 text-xs leading-5 text-kumo-subtle">
          {description}
        </Dialog.Description>
        {details && (
          <div className="mt-3 rounded-md border border-kumo-line bg-kumo-elevated p-2 font-mono text-[10px] text-kumo-subtle">
            {details}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-3 rounded-md border border-kumo-danger/35 bg-kumo-danger/10 px-2.5 py-2 text-xs text-kumo-danger">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={actionState.cancelDisabled}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            variant={destructive ? "destructive" : "primary"}
            loading={busy}
            disabled={actionState.confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

export function ProductPromptDialog({
  open,
  title,
  description,
  label,
  value,
  confirmLabel,
  busy = false,
  confirmDisabled = false,
  error,
  onValueChange,
  onOpenChange,
  onConfirm
}: {
  open: boolean;
  title: string;
  description: string;
  label: string;
  value: string;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
  onValueChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const actionState = productDialogActionState(busy, confirmDisabled);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !confirmDisabled) onConfirm();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="bg-kumo-base p-4 text-kumo-default">
        <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="mt-1 text-xs leading-5 text-kumo-subtle">
          {description}
        </Dialog.Description>
        <form className="mt-4" onSubmit={submit}>
          <label>
            <span className="mb-1 block text-[11px] font-medium text-kumo-subtle">
              {label}
            </span>
            <input
              autoFocus
              value={value}
              disabled={busy}
              className="w-full rounded-md border border-kumo-line bg-kumo-base px-2.5 py-2 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-accent focus:ring-1 focus:ring-kumo-accent/30 disabled:opacity-50"
              onChange={(event) => onValueChange(event.target.value)}
            />
          </label>
          {error && (
            <div role="alert" className="mt-2 rounded-md border border-kumo-danger/35 bg-kumo-danger/10 px-2.5 py-2 text-xs text-kumo-danger">
              {error}
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={actionState.cancelDisabled}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={busy}
              disabled={actionState.confirmDisabled}
            >
              {confirmLabel}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
