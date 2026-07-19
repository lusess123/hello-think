import type { TimelineNode } from "./types";

const NODE_WIDTH = 190;
const OPENING_WIDTH = 132;
const OPENING_HEIGHT = 58;
const HORIZONTAL_GAP = 72;
const VERTICAL_GAP = 94;
const HORIZONTAL_PADDING = 80;
const BOTTOM_PADDING = 92;

export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoryTreeLayout {
  width: number;
  height: number;
  nodes: Map<string, NodeBox>;
  parallelEvents: Map<string, NodeBox>;
  opening: NodeBox;
  ranks: Map<string, number>;
  layers: string[][];
}

/**
 * Turns next/routes into a stable top-down graph. Strongly connected nodes are
 * collapsed before ranking so malformed cycles have a finite, deterministic
 * fallback instead of making the layout loop forever.
 */
export function createStoryTreeLayout(
  timeline: TimelineNode[],
  opening: string,
  flowStartY = 390
): StoryTreeLayout {
  const nodeByKey = new Map(
    [...timeline]
      .sort((left, right) => compareKeys(left.key, right.key))
      .map((node) => [node.key, node])
  );
  const keys = [...nodeByKey.keys()];
  const known = new Set(keys);
  const successors = new Map(
    keys.map((key) => [key, storySuccessors(nodeByKey.get(key)!, known)])
  );
  const components = stronglyConnectedComponents(keys, successors);
  const componentByNode = new Map<string, string>();
  const membersByComponent = new Map<string, string[]>();
  for (const members of components) {
    const id = members[0]!;
    membersByComponent.set(id, members);
    for (const key of members) componentByNode.set(key, id);
  }

  const componentEdges = new Map<string, Set<string>>(
    [...membersByComponent.keys()].map((id) => [id, new Set<string>()])
  );
  for (const [source, destinations] of successors) {
    const sourceComponent = componentByNode.get(source)!;
    for (const destination of destinations) {
      const destinationComponent = componentByNode.get(destination)!;
      if (sourceComponent !== destinationComponent) {
        componentEdges.get(sourceComponent)!.add(destinationComponent);
      }
    }
  }

  const openingComponent = componentByNode.get(opening);
  const reachableComponents = openingComponent
    ? collectReachableComponents(openingComponent, componentEdges)
    : new Set<string>();
  const allComponents = new Set(membersByComponent.keys());
  const unreachableComponents = new Set(
    [...allComponents].filter((id) => !reachableComponents.has(id))
  );
  const reachableRanks = rankComponentDag(
    reachableComponents,
    componentEdges,
    0
  );
  const unreachableStart = reachableRanks.size
    ? Math.max(...reachableRanks.values()) + 1
    : 0;
  const unreachableRanks = rankComponentDag(
    unreachableComponents,
    componentEdges,
    unreachableStart
  );
  const ranks = new Map<string, number>();
  for (const key of keys) {
    const component = componentByNode.get(key)!;
    ranks.set(
      key,
      reachableRanks.get(component) ?? unreachableRanks.get(component) ?? 0
    );
  }

  const maximumRank = ranks.size ? Math.max(...ranks.values()) : -1;
  const layers = Array.from({ length: maximumRank + 1 }, () => [] as string[]);
  for (const key of keys) layers[ranks.get(key)!]!.push(key);
  for (const layer of layers) layer.sort(compareKeys);

  const maximumLayerWidth = Math.max(
    OPENING_WIDTH,
    ...layers.map((layer) =>
      layer.length
        ? layer.length * NODE_WIDTH + (layer.length - 1) * HORIZONTAL_GAP
        : 0
    )
  );
  const width = Math.max(880, maximumLayerWidth + HORIZONTAL_PADDING * 2);
  const openingBox: NodeBox = {
    x: (width - OPENING_WIDTH) / 2,
    y: flowStartY + 22,
    width: OPENING_WIDTH,
    height: OPENING_HEIGHT
  };
  const nodes = new Map<string, NodeBox>();
  const parallelEvents = new Map<string, NodeBox>();
  let layerY = flowStartY + 126;

  for (const layer of layers) {
    if (layer.length === 0) continue;
    const layerWidth =
      layer.length * NODE_WIDTH + (layer.length - 1) * HORIZONTAL_GAP;
    const layerHeight = Math.max(
      ...layer.map((key) => storyNodeHeight(nodeByKey.get(key)!))
    );
    const layerX = (width - layerWidth) / 2;
    layer.forEach((key, index) => {
      const node = nodeByKey.get(key)!;
      const box: NodeBox = {
        x: layerX + index * (NODE_WIDTH + HORIZONTAL_GAP),
        y: layerY,
        width: NODE_WIDTH,
        height: storyNodeHeight(node)
      };
      nodes.set(key, box);
      node.parallel?.forEach((event, eventIndex) => {
        parallelEvents.set(event.key, {
          x: box.x + 10,
          y: box.y + 55 + eventIndex * 36,
          width: box.width - 20,
          height: 31
        });
      });
    });
    layerY += layerHeight + VERTICAL_GAP;
  }

  const deepestBottom = nodes.size
    ? Math.max(...[...nodes.values()].map((box) => box.y + box.height))
    : openingBox.y + openingBox.height;
  return {
    width,
    height: deepestBottom + BOTTOM_PADDING,
    nodes,
    parallelEvents,
    opening: openingBox,
    ranks,
    layers
  };
}

function storySuccessors(node: TimelineNode, known: Set<string>): string[] {
  return [...new Set([node.next, ...Object.values(node.routes ?? {})])]
    .filter((key): key is string => Boolean(key && known.has(key)))
    .sort(compareKeys);
}

function storyNodeHeight(node: TimelineNode): number {
  return node.parallel ? 72 + node.parallel.length * 36 : 104;
}

function stronglyConnectedComponents(
  keys: string[],
  successors: Map<string, string[]>
): string[][] {
  let nextIndex = 0;
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (key: string) => {
    const index = nextIndex;
    nextIndex += 1;
    indexByNode.set(key, index);
    lowLinkByNode.set(key, index);
    stack.push(key);
    onStack.add(key);

    for (const destination of successors.get(key) ?? []) {
      if (!indexByNode.has(destination)) {
        visit(destination);
        lowLinkByNode.set(
          key,
          Math.min(lowLinkByNode.get(key)!, lowLinkByNode.get(destination)!)
        );
      } else if (onStack.has(destination)) {
        lowLinkByNode.set(
          key,
          Math.min(lowLinkByNode.get(key)!, indexByNode.get(destination)!)
        );
      }
    }

    if (lowLinkByNode.get(key) !== indexByNode.get(key)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === key) break;
    }
    components.push(component.sort(compareKeys));
  };

  for (const key of [...keys].sort(compareKeys)) {
    if (!indexByNode.has(key)) visit(key);
  }
  return components.sort((left, right) => compareKeys(left[0]!, right[0]!));
}

function collectReachableComponents(
  opening: string,
  edges: Map<string, Set<string>>
): Set<string> {
  const reachable = new Set<string>();
  const pending = [opening];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...[...(edges.get(current) ?? [])].sort(compareKeys));
  }
  return reachable;
}

function rankComponentDag(
  included: Set<string>,
  edges: Map<string, Set<string>>,
  startRank: number
): Map<string, number> {
  const indegrees = new Map([...included].map((id) => [id, 0]));
  for (const source of included) {
    for (const destination of edges.get(source) ?? []) {
      if (included.has(destination)) {
        indegrees.set(destination, indegrees.get(destination)! + 1);
      }
    }
  }
  const pending = [...included]
    .filter((id) => indegrees.get(id) === 0)
    .sort(compareKeys);
  const ranks = new Map([...included].map((id) => [id, startRank]));
  while (pending.length > 0) {
    const source = pending.shift()!;
    for (const destination of [...(edges.get(source) ?? [])].sort(compareKeys)) {
      if (!included.has(destination)) continue;
      ranks.set(
        destination,
        Math.max(ranks.get(destination)!, ranks.get(source)! + 1)
      );
      const remaining = indegrees.get(destination)! - 1;
      indegrees.set(destination, remaining);
      if (remaining === 0) {
        pending.push(destination);
        pending.sort(compareKeys);
      }
    }
  }
  return ranks;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
