import type {
  MysteryStoryDsl,
  StoryBond,
  StoryPerson,
  StoryTimelineNode,
} from "./schema";

export type StoryChangeKind = "added" | "removed" | "modified";

export interface StoryEntityChange<T> {
  kind: StoryChangeKind;
  key: string;
  before?: T;
  after?: T;
  changedFields: string[];
}

export interface StoryBusinessDiff {
  story: StoryEntityChange<{ opening: string }>[];
  cast: StoryEntityChange<StoryPerson>[];
  bonds: StoryEntityChange<StoryBond>[];
  timeline: StoryEntityChange<StoryTimelineNode>[];
  summary: {
    added: number;
    removed: number;
    modified: number;
    total: number;
  };
}

export interface JsonDiffLine {
  kind: "context" | "added" | "removed";
  value: string;
  oldLine?: number;
  newLine?: number;
}

const own = Object.prototype.hasOwnProperty;

function comparable(value: unknown): string {
  return JSON.stringify(value);
}

function changedFields<T extends object>(before: T, after: T): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) =>
      !own.call(before, key) ||
      !own.call(after, key) ||
      comparable(before[key as keyof T]) !== comparable(after[key as keyof T])
  );
}

function diffByKey<T extends object>(
  before: T[],
  after: T[],
  keyOf: (item: T, index: number) => string
): StoryEntityChange<T>[] {
  const oldItems = new Map(before.map((item, index) => [keyOf(item, index), item]));
  const newItems = new Map(after.map((item, index) => [keyOf(item, index), item]));
  return diffMaps(oldItems, newItems);
}

function diffMaps<T extends object>(
  oldItems: Map<string, T>,
  newItems: Map<string, T>
): StoryEntityChange<T>[] {
  const keys = [...new Set([...oldItems.keys(), ...newItems.keys()])];
  const changes: StoryEntityChange<T>[] = [];
  for (const key of keys) {
    const oldItem = oldItems.get(key);
    const newItem = newItems.get(key);
    if (!oldItem && newItem) {
      changes.push({ kind: "added", key, after: newItem, changedFields: Object.keys(newItem) });
      continue;
    }
    if (oldItem && !newItem) {
      changes.push({ kind: "removed", key, before: oldItem, changedFields: Object.keys(oldItem) });
      continue;
    }
    if (!oldItem || !newItem) continue;
    const fields = changedFields(oldItem, newItem);
    if (fields.length) {
      changes.push({ kind: "modified", key, before: oldItem, after: newItem, changedFields: fields });
    }
  }
  return changes;
}

function keyedBonds(bonds: StoryBond[]): Map<string, StoryBond> {
  const occurrences = new Map<string, number>();
  return new Map(bonds.map((bond) => {
    const pair = `${bond.source}\u0000${bond.target}`;
    const occurrence = occurrences.get(pair) ?? 0;
    occurrences.set(pair, occurrence + 1);
    const key = `${bond.source}→${bond.target}${occurrence ? `#${occurrence + 1}` : ""}`;
    return [key, bond];
  }));
}

export function createStoryBusinessDiff(
  before: MysteryStoryDsl,
  after: MysteryStoryDsl
): StoryBusinessDiff {
  const beforeStory = { opening: before.storyline.opening };
  const afterStory = { opening: after.storyline.opening };
  const story =
    beforeStory.opening === afterStory.opening
      ? []
      : [
          {
            kind: "modified" as const,
            key: "storyline",
            before: beforeStory,
            after: afterStory,
            changedFields: ["opening"],
          },
        ];
  const cast = diffByKey(before.cast, after.cast, (person) => person.key);
  const bonds = diffMaps(keyedBonds(before.bonds), keyedBonds(after.bonds));
  const timeline = diffByKey(
    before.storyline.timeline,
    after.storyline.timeline,
    (node) => node.key
  );
  const allChanges = [...story, ...cast, ...bonds, ...timeline];
  const added = allChanges.filter((change) => change.kind === "added").length;
  const removed = allChanges.filter((change) => change.kind === "removed").length;
  const modified = allChanges.filter((change) => change.kind === "modified").length;

  return {
    story,
    cast,
    bonds,
    timeline,
    summary: { added, removed, modified, total: added + removed + modified },
  };
}

function splitLines(value: string): string[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Produces a stable, line-oriented JSON diff. It uses an LCS for normal story
 * files and a bounded fallback for unusually large inputs, so a diff cannot
 * exhaust a Worker's memory simply because a generated story is very large.
 */
export function createJsonLineDiff(beforeJson: string, afterJson: string): JsonDiffLine[] {
  const before = splitLines(beforeJson);
  const after = splitLines(afterJson);

  if (before.length * after.length > 2_000_000) {
    return createBoundedLineDiff(before, after);
  }

  const table = Array.from({ length: before.length + 1 }, () =>
    new Uint32Array(after.length + 1)
  );
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        before[oldIndex] === after[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  const result: JsonDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (
      oldIndex < before.length &&
      newIndex < after.length &&
      before[oldIndex] === after[newIndex]
    ) {
      result.push({
        kind: "context",
        value: before[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < after.length &&
      (oldIndex === before.length || table[oldIndex][newIndex + 1] >= table[oldIndex + 1][newIndex])
    ) {
      result.push({ kind: "added", value: after[newIndex], newLine: newIndex + 1 });
      newIndex += 1;
    } else {
      result.push({ kind: "removed", value: before[oldIndex], oldLine: oldIndex + 1 });
      oldIndex += 1;
    }
  }
  return result;
}

function createBoundedLineDiff(before: string[], after: string[]): JsonDiffLine[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const result: JsonDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    result.push({ kind: "context", value: before[index], oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = prefix; index < before.length - suffix; index += 1) {
    result.push({ kind: "removed", value: before[index], oldLine: index + 1 });
  }
  for (let index = prefix; index < after.length - suffix; index += 1) {
    result.push({ kind: "added", value: after[index], newLine: index + 1 });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const oldIndex = before.length - offset;
    const newIndex = after.length - offset;
    result.push({
      kind: "context",
      value: before[oldIndex],
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    });
  }
  return result;
}
