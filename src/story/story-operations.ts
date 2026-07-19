import {
  MysteryStoryDslSchema,
  PERSON_RELATIONS,
  TimelineNodeSchema,
  cloneStory,
  type MysteryStoryDsl,
  type PersonRelation,
  type StoryBond,
  type StoryPerson,
  type StoryWorkspace,
  type TimelineNode
} from "./types";
import {
  findStoryBondIndex,
  type StoryEditorTarget
} from "./ui-model";

export function storyEntityForTarget(
  workspace: StoryWorkspace,
  target: StoryEditorTarget
): { opening: string } | StoryPerson | StoryBond | TimelineNode {
  const story = workspace.story;
  if (target.kind === "opening") {
    return { opening: story.storyline.opening };
  }
  const fallback = workspace.diff.items.find(
    (item) =>
      (item.category ?? item.scope) === targetCategory(target) &&
      item.label === target.key
  );

  if (target.kind === "person") {
    if (target.key === null) return { key: "", name: "", identity: "" };
    return (
      story.cast.find((person) => person.key === target.key) ??
      (fallback?.before as StoryPerson | undefined) ??
      { key: target.key, name: target.key, identity: "" }
    );
  }

  if (target.kind === "bond") {
    if (target.key === null) return emptyBond(story);
    const index = findStoryBondIndex(story.bonds, target.key);
    return (
      story.bonds[index] ??
      (fallback?.before as StoryBond | undefined) ??
      emptyBond(story)
    );
  }

  if (target.key === null) return newTimelineNode(story);
  return (
    story.storyline.timeline.find((node) => node.key === target.key) ??
    (fallback?.before as TimelineNode | undefined) ??
    newTimelineNode(story)
  );
}

export function storyTargetExists(
  story: MysteryStoryDsl,
  target: StoryEditorTarget
): boolean {
  if (target.kind === "opening") return true;
  if (target.key === null) return false;
  if (target.kind === "person") {
    return story.cast.some((person) => person.key === target.key);
  }
  if (target.kind === "bond") {
    return findStoryBondIndex(story.bonds, target.key) >= 0;
  }
  return story.storyline.timeline.some((node) => node.key === target.key);
}

export function applyStoryEntity(
  story: MysteryStoryDsl,
  target: StoryEditorTarget,
  value: unknown
): MysteryStoryDsl {
  const next = cloneStory(story);

  if (target.kind === "opening") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("开场配置必须是 JSON 对象");
    }
    const opening = requiredString(
      (value as Record<string, unknown>).opening,
      "开场节点"
    );
    const knownNodes = new Set([
      ...next.storyline.timeline.map((node) => node.key),
      ...next.storyline.timeline.flatMap(
        (node) => node.parallel?.map((event) => event.key) ?? []
      )
    ]);
    if (!knownNodes.has(opening)) {
      throw new Error(`开场节点不存在：${opening}`);
    }
    next.storyline.opening = opening;
  } else if (target.kind === "person") {
    const person = parsePerson(value);
    const index =
      target.key === null
        ? -1
        : next.cast.findIndex((candidate) => candidate.key === target.key);
    if (
      next.cast.some(
        (candidate, candidateIndex) =>
          candidate.key === person.key && candidateIndex !== index
      )
    ) {
      throw new Error(`人物 key 已存在：${person.key}`);
    }
    if (index < 0) next.cast.push(person);
    else {
      next.cast[index] = person;
      if (target.key && target.key !== person.key) {
        remapPersonReferences(next, target.key, person.key);
      }
    }
  } else if (target.kind === "bond") {
    const bond = parseBond(value);
    if (bond.source === bond.target) throw new Error("人物不能与自己建立关系");
    const index =
      target.key === null ? -1 : findStoryBondIndex(next.bonds, target.key);
    if (index < 0) next.bonds.push(bond);
    else next.bonds[index] = bond;
  } else {
    const validation = TimelineNodeSchema.safeParse(value);
    if (!validation.success) {
      throw new Error(
        validation.error.issues
          .slice(0, 6)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("；")
      );
    }
    const node = validation.data;
    const index =
      target.key === null
        ? -1
        : next.storyline.timeline.findIndex(
            (candidate) => candidate.key === target.key
          );
    if (
      next.storyline.timeline.some(
        (candidate, candidateIndex) =>
          candidate.key === node.key && candidateIndex !== index
      )
    ) {
      throw new Error(`节点 key 已存在：${node.key}`);
    }
    if (index < 0) {
      const last = next.storyline.timeline.at(-1);
      if (last?.end) {
        delete last.end;
        last.next = node.key;
      }
      next.storyline.timeline.push(node);
      if (!next.storyline.opening) next.storyline.opening = node.key;
    } else {
      next.storyline.timeline[index] = node;
      if (target.key && target.key !== node.key) {
        remapNodeReferences(next, target.key, node.key);
      }
    }
  }

  const validation = MysteryStoryDslSchema.safeParse(next);
  if (!validation.success) {
    throw new Error(
      validation.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；")
    );
  }
  return validation.data;
}

export function deleteStoryTarget(
  story: MysteryStoryDsl,
  target: StoryEditorTarget
): MysteryStoryDsl {
  if (target.kind === "opening") return story;
  if (target.key === null) return story;
  const next = cloneStory(story);

  if (target.kind === "person") {
    const person = next.cast.find((candidate) => candidate.key === target.key);
    if (!person) return next;
    if (personUsedByTimeline(next, target.key)) {
      throw new Error("该人物仍被时间线引用，请先调整时间线节点");
    }
    next.cast = next.cast.filter((candidate) => candidate.key !== target.key);
    next.bonds = next.bonds.filter(
      (bond) => bond.source !== target.key && bond.target !== target.key
    );
  } else if (target.kind === "bond") {
    const index = findStoryBondIndex(next.bonds, target.key);
    if (index >= 0) next.bonds.splice(index, 1);
  } else {
    if (next.storyline.timeline.length <= 1) {
      throw new Error("时间线必须至少保留一个节点");
    }
    const node = next.storyline.timeline.find(
      (candidate) => candidate.key === target.key
    );
    if (!node) return next;
    const deletedKeys = new Set([
      node.key,
      ...(node.parallel?.map((event) => event.key) ?? [])
    ]);
    next.storyline.timeline = next.storyline.timeline.filter(
      (candidate) => candidate.key !== target.key
    );
    sanitizeDeletedNodeReferences(next, deletedKeys);
    if (deletedKeys.has(next.storyline.opening)) {
      next.storyline.opening = next.storyline.timeline[0]!.key;
    }
  }

  return MysteryStoryDslSchema.parse(next);
}

export function storyTargetLabel(
  workspace: StoryWorkspace,
  target: StoryEditorTarget
): string {
  if (target.kind === "opening") {
    return `开场节点 ${workspace.story.storyline.opening}`;
  }
  const entity = storyEntityForTarget(workspace, target);
  if (target.kind === "person") return (entity as StoryPerson).name || "新人物";
  if (target.kind === "bond") {
    const bond = entity as StoryBond;
    return `${bond.source} → ${bond.target}`;
  }
  return (entity as TimelineNode).key || "新事件";
}

export function storyTargetSource(
  target: StoryEditorTarget
): "relationship-panel" | "timeline-panel" {
  return target.kind === "timeline" || target.kind === "opening"
    ? "timeline-panel"
    : "relationship-panel";
}

function targetCategory(target: StoryEditorTarget): "cast" | "bonds" | "timeline" {
  if (target.kind === "opening") return "timeline";
  return target.kind === "person"
    ? "cast"
    : target.kind === "bond"
      ? "bonds"
      : "timeline";
}

function parsePerson(value: unknown): StoryPerson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("人物必须是 JSON 对象");
  }
  const person = value as Record<string, unknown>;
  const result = {
    key: requiredString(person.key, "人物 key"),
    name: requiredString(person.name, "姓名"),
    identity: requiredString(person.identity, "身份")
  };
  return result;
}

function parseBond(value: unknown): StoryBond {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("关系必须是 JSON 对象");
  }
  const bond = value as Record<string, unknown>;
  const relation = requiredString(bond.relation, "关系类型");
  if (!PERSON_RELATIONS.includes(relation as PersonRelation)) {
    throw new Error(`未知关系类型：${relation}`);
  }
  return {
    source: requiredString(bond.source, "源人物"),
    relation: relation as PersonRelation,
    target: requiredString(bond.target, "目标人物")
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空`);
  }
  return value.trim();
}

function emptyBond(story: MysteryStoryDsl): StoryBond {
  return {
    source: story.cast[0]?.key ?? "",
    relation: "friend",
    target: story.cast[1]?.key ?? story.cast[0]?.key ?? ""
  };
}

function newTimelineNode(story: MysteryStoryDsl): TimelineNode {
  let index = story.storyline.timeline.length + 1;
  let key = `event_${String(index).padStart(2, "0")}`;
  const known = new Set(story.storyline.timeline.map((node) => node.key));
  while (known.has(key)) {
    index += 1;
    key = `event_${String(index).padStart(2, "0")}`;
  }
  const previousTime = story.storyline.timeline.at(-1)?.at ?? "00:00";
  return {
    key,
    at: addMinutes(previousTime, 10),
    event: "待补充事件",
    end: true
  };
}

function remapPersonReferences(
  story: MysteryStoryDsl,
  previousKey: string,
  nextKey: string
) {
  story.bonds = story.bonds.map((bond) => ({
    ...bond,
    source: bond.source === previousKey ? nextKey : bond.source,
    target: bond.target === previousKey ? nextKey : bond.target
  }));
  story.storyline.timeline = story.storyline.timeline.map((node) => ({
    ...node,
    actor: node.actor === previousKey ? nextKey : node.actor,
    actors: node.actors?.map((key) => (key === previousKey ? nextKey : key)),
    changes: node.changes?.map((change) => ({
      ...change,
      person: change.person === previousKey ? nextKey : change.person
    })),
    parallel: node.parallel?.map((event) => ({
      ...event,
      actor: event.actor === previousKey ? nextKey : event.actor
    }))
  }));
}

function personUsedByTimeline(story: MysteryStoryDsl, personKey: string) {
  return story.storyline.timeline.some(
    (node) =>
      node.actor === personKey ||
      node.actors?.includes(personKey) ||
      node.changes?.some((change) => change.person === personKey) ||
      node.parallel?.some((event) => event.actor === personKey)
  );
}

function remapNodeReferences(
  story: MysteryStoryDsl,
  previousKey: string,
  nextKey: string
) {
  if (story.storyline.opening === previousKey) {
    story.storyline.opening = nextKey;
  }
  story.storyline.timeline = story.storyline.timeline.map((node) => ({
    ...node,
    next: node.next === previousKey ? nextKey : node.next,
    routes: node.routes
      ? Object.fromEntries(
          Object.entries(node.routes).map(([route, target]) => [
            route,
            target === previousKey ? nextKey : target
          ])
        )
      : undefined,
    waitFor: node.waitFor?.map((key) =>
      key === previousKey ? nextKey : key
    )
  }));
}

function sanitizeDeletedNodeReferences(
  story: MysteryStoryDsl,
  deletedKeys: Set<string>
) {
  story.storyline.timeline = story.storyline.timeline.map((node) => {
    const next = { ...node };
    if (next.next && deletedKeys.has(next.next)) {
      delete next.next;
      next.end = true;
    }
    if (next.routes) {
      next.routes = Object.fromEntries(
        Object.entries(next.routes).filter(([, target]) => !deletedKeys.has(target))
      );
      if (Object.keys(next.routes).length === 0) {
        delete next.routes;
        next.end = true;
      }
    }
    if (next.waitFor) {
      next.waitFor = next.waitFor.filter((key) => !deletedKeys.has(key));
      if (next.waitFor.length === 0) delete next.waitFor;
    }
    return next;
  });
}

function addMinutes(value: string, increment: number): string {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  const total = (hour * 60 + minute + increment) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60
  ).padStart(2, "0")}`;
}
