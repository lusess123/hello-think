export function normalizedRename(
  current: string,
  draft: string
): string | null {
  const next = draft.trim();
  return !next || next === current ? null : next;
}

export function productDialogActionState(
  busy: boolean,
  confirmDisabled = false
) {
  return {
    cancelDisabled: busy,
    confirmDisabled: busy || confirmDisabled
  };
}
