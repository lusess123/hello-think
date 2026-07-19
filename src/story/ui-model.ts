import type {
  MysteryStoryDsl,
  StoryBond,
  StoryDiffAction,
  StoryDiffCategory,
  StoryDiffItem
} from "./types";

export type StoryEditorTarget =
  | { kind: "opening" }
  | { kind: "person"; key: string | null }
  | { kind: "bond"; key: string | null }
  | { kind: "timeline"; key: string | null };

export function storyEditorTargetId(target: StoryEditorTarget): string {
  return target.kind === "opening"
    ? "opening:storyline"
    : `${target.kind}:${target.key ?? "new"}`;
}

export interface LocalDraftState<T> {
  value: T;
  dirty: boolean;
  seenRevision: number;
  conflictRevision?: number;
}

export function createLocalDraft<T>(
  value: T,
  revision: number
): LocalDraftState<T> {
  return { value, dirty: false, seenRevision: revision };
}

export function editLocalDraft<T>(
  state: LocalDraftState<T>,
  value: T
): LocalDraftState<T> {
  return { ...state, value, dirty: true };
}

/**
 * Reconcile a server revision without ever erasing unsaved browser input.
 * Clean drafts follow the server; dirty drafts surface an explicit conflict.
 */
export function receiveRemoteDraft<T>(
  state: LocalDraftState<T>,
  remoteValue: T,
  revision: number
): LocalDraftState<T> {
  if (revision === state.seenRevision) return state;
  if (state.dirty) {
    return { ...state, conflictRevision: revision };
  }
  return { value: remoteValue, dirty: false, seenRevision: revision };
}

export function adoptRemoteDraft<T>(
  remoteValue: T,
  revision: number
): LocalDraftState<T> {
  return { value: remoteValue, dirty: false, seenRevision: revision };
}

export function keepLocalDraft<T>(
  state: LocalDraftState<T>,
  revision: number
): LocalDraftState<T> {
  return {
    ...state,
    seenRevision: revision,
    conflictRevision: undefined
  };
}

/** Matches the backend's stable source/target + occurrence Git diff key. */
export function storyBondKey(
  bonds: readonly StoryBond[],
  index: number
): string {
  const bond = bonds[index];
  if (!bond) return `missing-bond:${index}`;
  let occurrence = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const previous = bonds[cursor];
    if (
      previous?.source === bond.source &&
      previous.target === bond.target
    ) {
      occurrence += 1;
    }
  }
  return `${bond.source}→${bond.target}${
    occurrence ? `#${occurrence + 1}` : ""
  }`;
}

export function findStoryBondIndex(
  bonds: readonly StoryBond[],
  key: string
): number {
  return bonds.findIndex((_, index) => storyBondKey(bonds, index) === key);
}

export interface StoryDiffMarker {
  action: StoryDiffAction;
  fields: string[];
  item: StoryDiffItem;
}

export function storyDiffMarker(
  items: readonly StoryDiffItem[],
  category: StoryDiffCategory,
  key: string
): StoryDiffMarker | undefined {
  const item = items.find(
    (candidate) =>
      (candidate.category ?? candidate.scope) === category &&
      (candidate.label === key || candidate.path === `/${category}/${key}`)
  );
  if (!item) return undefined;
  return {
    action: item.action ?? item.type ?? "modified",
    fields: item.changedFields ?? [],
    item
  };
}

export function storyAtEvent(
  event: { afterStory?: MysteryStoryDsl; beforeStory?: MysteryStoryDsl },
  side: "before" | "after" = "after"
): MysteryStoryDsl | undefined {
  return side === "after" ? event.afterStory : event.beforeStory;
}
