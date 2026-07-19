import type {
  PersonRelation,
  StoryBond,
  StoryDiffAction,
  StoryDiffItem,
  StoryPerson,
  StoryWorkspace,
  TimelineNode
} from "./types";
import {
  storyBondKey,
  storyDiffMarker,
  type StoryDiffMarker,
  type StoryEditorTarget
} from "./ui-model";

export type StoryFormKind = "opening" | "person" | "bond" | "timeline";
export type StoryFormFilter = "all" | StoryFormKind;

export interface StoryFormFact {
  label: string;
  value: string;
}

export interface StoryFormItem {
  id: string;
  kind: StoryFormKind;
  kindLabel: string;
  title: string;
  subtitle: string;
  facts: StoryFormFact[];
  target: StoryEditorTarget;
  marker?: StoryDiffMarker;
  removed: boolean;
  searchText: string;
}

export interface StoryDiffCounts {
  added: number;
  modified: number;
  removed: number;
  total: number;
}

const RELATION_LABELS: Record<PersonRelation, string> = {
  sibling: "手足",
  business_partner: "商业伙伴",
  friend: "朋友",
  rival: "对手"
};

interface DisplayPerson {
  person: StoryPerson;
  removed: boolean;
}

interface DisplayBond {
  bond: StoryBond;
  key: string;
  removed: boolean;
}

interface DisplayTimeline {
  node: TimelineNode;
  removed: boolean;
}

export function buildStoryFormItems(workspace: StoryWorkspace): StoryFormItem[] {
  const story = workspace.story;
  const diffItems = workspace.diff.items;
  const people = displayPeople(story.cast, diffItems);
  const bonds = displayBonds(story.bonds, diffItems);
  const timeline = displayTimeline(story.storyline.timeline, diffItems);
  const peopleByKey = new Map(
    people.map(({ person }) => [person.key, person] as const)
  );
  const timelineByKey = new Map(
    timeline.map(({ node }) => [node.key, node] as const)
  );
  const openingNode = timelineByKey.get(story.storyline.opening);

  return [
    formItem({
      id: "opening:storyline",
      kind: "opening",
      kindLabel: "开场",
      title: "开场入口",
      subtitle: openingNode ? timelineEvent(openingNode) : "入口节点不存在",
      facts: [
        { label: "节点", value: story.storyline.opening },
        { label: "时间", value: openingNode?.at ?? "—" },
        { label: "参与者", value: openingNode ? actorNames(openingNode, peopleByKey) : "—" }
      ],
      target: { kind: "opening" },
      marker: storyDiffMarker(diffItems, "story", "storyline"),
      removed: false
    }),
    ...people.map(({ person, removed }) =>
      formItem({
        id: `person:${person.key}`,
        kind: "person",
        kindLabel: "人物",
        title: person.name,
        subtitle: person.identity,
        facts: [
          { label: "标识", value: person.key },
          { label: "身份", value: person.identity }
        ],
        target: { kind: "person", key: person.key },
        marker: storyDiffMarker(diffItems, "cast", person.key),
        removed
      })
    ),
    ...bonds.map(({ bond, key, removed }) => {
      const sourceName = personName(bond.source, peopleByKey);
      const targetName = personName(bond.target, peopleByKey);
      return formItem({
        id: `bond:${key}`,
        kind: "bond",
        kindLabel: "关系",
        title: `${sourceName} → ${targetName}`,
        subtitle: RELATION_LABELS[bond.relation],
        facts: [
          { label: "标识", value: key },
          { label: "源人物", value: `${sourceName} · ${bond.source}` },
          { label: "目标", value: `${targetName} · ${bond.target}` },
          { label: "关系", value: RELATION_LABELS[bond.relation] }
        ],
        target: { kind: "bond", key },
        marker: storyDiffMarker(diffItems, "bonds", key),
        removed
      });
    }),
    ...timeline.map(({ node, removed }) =>
      formItem({
        id: `timeline:${node.key}`,
        kind: "timeline",
        kindLabel: "剧情",
        title: timelineEvent(node),
        subtitle: node.parallel ? `${node.parallel.length} 条并行事件` : node.key,
        facts: [
          { label: "节点", value: node.key },
          { label: "时间", value: node.at },
          { label: "参与者", value: actorNames(node, peopleByKey) },
          { label: "出口", value: timelineExit(node) }
        ],
        target: { kind: "timeline", key: node.key },
        marker: storyDiffMarker(diffItems, "timeline", node.key),
        removed
      })
    )
  ];
}

export function filterStoryFormItems(
  items: readonly StoryFormItem[],
  filter: StoryFormFilter,
  query: string
): StoryFormItem[] {
  const normalizedQuery = normalize(query);
  return items.filter(
    (item) =>
      (filter === "all" || item.kind === filter) &&
      (!normalizedQuery || item.searchText.includes(normalizedQuery))
  );
}

export function countStoryDiff(items: readonly StoryDiffItem[]): StoryDiffCounts {
  const counts: StoryDiffCounts = {
    added: 0,
    modified: 0,
    removed: 0,
    total: items.length
  };
  for (const item of items) {
    counts[diffAction(item)] += 1;
  }
  return counts;
}

function formItem(
  item: Omit<StoryFormItem, "searchText">
): StoryFormItem {
  const searchText = normalize(
    [
      item.kindLabel,
      item.title,
      item.subtitle,
      ...item.facts.flatMap((fact) => [fact.label, fact.value]),
      ...(item.marker?.fields ?? [])
    ].join(" ")
  );
  return { ...item, searchText };
}

function displayPeople(
  cast: readonly StoryPerson[],
  diffItems: readonly StoryDiffItem[]
): DisplayPerson[] {
  const people = cast.map((person) => ({ person, removed: false }));
  for (const item of diffItems) {
    if (
      diffCategory(item) === "cast" &&
      diffAction(item) === "removed" &&
      isRecord(item.before)
    ) {
      const person = item.before as StoryPerson;
      if (
        typeof person.key === "string" &&
        !people.some((entry) => entry.person.key === person.key)
      ) {
        people.push({ person, removed: true });
      }
    }
  }
  return people;
}

function displayBonds(
  current: readonly StoryBond[],
  diffItems: readonly StoryDiffItem[]
): DisplayBond[] {
  const bonds = current.map((bond, index) => ({
    bond,
    key: storyBondKey(current, index),
    removed: false
  }));
  for (const item of diffItems) {
    if (
      diffCategory(item) === "bonds" &&
      diffAction(item) === "removed" &&
      isRecord(item.before)
    ) {
      const key = item.label ?? item.path?.split("/").at(-1);
      if (key && !bonds.some((entry) => entry.key === key)) {
        bonds.push({
          bond: item.before as StoryBond,
          key,
          removed: true
        });
      }
    }
  }
  return bonds;
}

function displayTimeline(
  current: readonly TimelineNode[],
  diffItems: readonly StoryDiffItem[]
): DisplayTimeline[] {
  const timeline = current.map((node) => ({ node, removed: false }));
  for (const item of diffItems) {
    if (
      diffCategory(item) === "timeline" &&
      diffAction(item) === "removed" &&
      isRecord(item.before)
    ) {
      const node = item.before as TimelineNode;
      if (
        typeof node.key === "string" &&
        !timeline.some((entry) => entry.node.key === node.key)
      ) {
        timeline.push({ node, removed: true });
      }
    }
  }
  return timeline;
}

function timelineEvent(node: TimelineNode): string {
  if (!node.parallel) return node.event ?? "未命名剧情事件";
  const events = node.parallel.map((event) => event.event).filter(Boolean);
  return events.length > 0 ? events.join(" / ") : "并行事件组";
}

function actorNames(
  node: TimelineNode,
  peopleByKey: ReadonlyMap<string, StoryPerson>
): string {
  const actorKeys = node.parallel
    ? node.parallel.map((event) => event.actor)
    : node.actors ?? (node.actor ? [node.actor] : []);
  const names = [...new Set(actorKeys)].map((key) => personName(key, peopleByKey));
  return names.length > 0 ? names.join("、") : "—";
}

function timelineExit(node: TimelineNode): string {
  if (node.end) return "结束";
  if (node.next) return `下一节点 · ${node.next}`;
  const routes = Object.entries(node.routes ?? {});
  return routes.length > 0
    ? routes.map(([label, target]) => `${label} → ${target}`).join(" / ")
    : "—";
}

function personName(
  key: string,
  peopleByKey: ReadonlyMap<string, StoryPerson>
): string {
  return peopleByKey.get(key)?.name ?? key;
}

function diffAction(item: StoryDiffItem): StoryDiffAction {
  return item.action ?? item.type ?? "modified";
}

function diffCategory(item: StoryDiffItem): string | undefined {
  return item.category ?? item.scope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
