import { z } from "zod";

export const PersonStateChangeSchema = z.object({
  person: z.string(),
  state: z.enum(["suspected", "missing", "safe", "cleared", "found"]),
});

export const ParallelEventSchema = z.object({
  key: z.string(),
  actor: z.string(),
  event: z.string(),
  requires: z.array(z.string()).optional(),
  produces: z.array(z.string()).optional(),
  outcomes: z.record(z.string(), z.array(z.string())).optional(),
});

export const TimelineNodeSchema = z
  .object({
    key: z.string(),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须使用 HH:mm 格式"),
    actor: z.string().optional(),
    actors: z.array(z.string()).optional(),
    event: z.string().optional(),
    requires: z.array(z.string()).optional(),
    produces: z.array(z.string()).optional(),
    changes: z.array(PersonStateChangeSchema).optional(),
    next: z.string().optional(),
    routes: z.record(z.string(), z.string()).optional(),
    waitFor: z.array(z.string()).optional(),
    parallel: z.array(ParallelEventSchema).optional(),
    end: z.literal(true).optional(),
  })
  .superRefine((node, context) => {
    const isParallelGroup = node.parallel !== undefined;

    if (isParallelGroup && node.event !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "并行容器不应同时声明 event",
        path: ["event"],
      });
    }

    if (!isParallelGroup && node.event === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "普通时间线节点必须声明 event",
        path: ["event"],
      });
    }

    const exits = [node.next, node.routes, node.end].filter(Boolean);
    if (exits.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "每个节点必须且只能使用 next、routes 或 end 中的一种出口",
      });
    }
  });

export const MysteryStoryDslSchema = z
  .object({
    cast: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        identity: z.string(),
      })
    ),
    bonds: z.array(
      z.object({
        source: z.string(),
        relation: z.enum(["sibling", "business_partner", "friend", "rival"]),
        target: z.string(),
      })
    ),
    storyline: z.object({
      opening: z.string(),
      timeline: z.array(TimelineNodeSchema),
    }),
  })
  .superRefine((story, context) => {
    const people = new Set(story.cast.map((person) => person.key));
    const personKeys = story.cast.map((person) => person.key);
    const duplicatePerson = personKeys.find(
      (key, index) => personKeys.indexOf(key) !== index
    );

    if (duplicatePerson) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `人物 key 重复：${duplicatePerson}`,
        path: ["cast"],
      });
    }

    story.bonds.forEach((bond, index) => {
      if (!people.has(bond.source) || !people.has(bond.target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "人物关系引用了不存在的人物",
          path: ["bonds", index],
        });
      }
    });

    const topLevelKeys = story.storyline.timeline.map((node) => node.key);
    const parallelKeys = story.storyline.timeline.flatMap(
      (node) => node.parallel?.map((event) => event.key) ?? []
    );
    const allKeys = [...topLevelKeys, ...parallelKeys];
    const knownNodes = new Set(allKeys);
    const duplicateNode = allKeys.find(
      (key, index) => allKeys.indexOf(key) !== index
    );

    if (duplicateNode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `时间线节点 key 重复：${duplicateNode}`,
        path: ["storyline", "timeline"],
      });
    }

    if (!knownNodes.has(story.storyline.opening)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "opening 引用了不存在的节点",
        path: ["storyline", "opening"],
      });
    }

    const assertPerson = (person: string, path: (string | number)[]) => {
      if (!people.has(person)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `引用了不存在的人物：${person}`,
          path,
        });
      }
    };

    const assertNode = (node: string, path: (string | number)[]) => {
      if (!knownNodes.has(node)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `引用了不存在的节点：${node}`,
          path,
        });
      }
    };

    story.storyline.timeline.forEach((node, index) => {
      if (node.actor) {
        assertPerson(node.actor, ["storyline", "timeline", index, "actor"]);
      }
      node.actors?.forEach((person, personIndex) =>
        assertPerson(person, [
          "storyline",
          "timeline",
          index,
          "actors",
          personIndex,
        ])
      );
      node.changes?.forEach((change, changeIndex) =>
        assertPerson(change.person, [
          "storyline",
          "timeline",
          index,
          "changes",
          changeIndex,
          "person",
        ])
      );
      node.parallel?.forEach((event, eventIndex) =>
        assertPerson(event.actor, [
          "storyline",
          "timeline",
          index,
          "parallel",
          eventIndex,
          "actor",
        ])
      );

      if (node.next) {
        assertNode(node.next, ["storyline", "timeline", index, "next"]);
      }
      Object.entries(node.routes ?? {}).forEach(([route, target]) =>
        assertNode(target, ["storyline", "timeline", index, "routes", route])
      );
      node.waitFor?.forEach((target, targetIndex) =>
        assertNode(target, [
          "storyline",
          "timeline",
          index,
          "waitFor",
          targetIndex,
        ])
      );
    });
  });

export type MysteryStoryDsl = z.infer<typeof MysteryStoryDslSchema>;
export type StoryPerson = MysteryStoryDsl["cast"][number];
export type StoryBond = MysteryStoryDsl["bonds"][number];
export type StoryTimelineNode = MysteryStoryDsl["storyline"]["timeline"][number];

export function parseMysteryStoryDsl(value: unknown): MysteryStoryDsl {
  return MysteryStoryDslSchema.parse(value);
}

export function parseMysteryStoryJson(json: string): MysteryStoryDsl {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new StoryJsonSyntaxError(
      error instanceof Error ? error.message : "JSON 格式无效"
    );
  }
  return parseMysteryStoryDsl(value);
}

export function serializeMysteryStory(story: MysteryStoryDsl): string {
  return `${JSON.stringify(MysteryStoryDslSchema.parse(story), null, 2)}\n`;
}

export class StoryJsonSyntaxError extends Error {
  readonly code = "STORY_JSON_SYNTAX_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "StoryJsonSyntaxError";
  }
}
