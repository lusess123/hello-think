import {
  ArrowsOutIcon,
  GitDiffIcon,
  MinusIcon,
  PlusIcon,
  UsersThreeIcon
} from "@phosphor-icons/react";
import { Badge, Button } from "@cloudflare/kumo";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { VirtualList } from "../components/virtual-list";
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
  createStoryTreeLayout,
  type NodeBox,
  type StoryTreeLayout
} from "./story-tree-layout";
import {
  storyBondKey,
  storyDiffMarker,
  type StoryDiffMarker,
  type StoryEditorTarget
} from "./ui-model";
import {
  StoryDiffBadge,
  StoryEmpty,
  StorySectionHeader,
  STORY_PANEL_CLASS,
  storyDiffSurface
} from "./story-ui";

const RELATION_LABELS: Record<PersonRelation, string> = {
  sibling: "手足",
  business_partner: "商业伙伴",
  friend: "朋友",
  rival: "对手"
};

const RELATION_HEIGHT = 340;
const FLOW_START_Y = 390;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.8;

interface DesignViewProps {
  workspace: StoryWorkspace;
  disabled: boolean;
  onEdit: (target: StoryEditorTarget) => void;
}

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

interface Point {
  x: number;
  y: number;
}

interface CanvasLayout extends StoryTreeLayout {
  people: Map<string, Point>;
}

interface CanvasIndexItem {
  id: string;
  label: string;
  meta: string;
  target: StoryEditorTarget;
  marker?: StoryDiffMarker;
}

interface CanvasViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function DesignView({ workspace, disabled, onEdit }: DesignViewProps) {
  const story = workspace.story;
  const diffItems = workspace.diff.items;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [canvasViewport, setCanvasViewport] = useState<CanvasViewport>({
    x: 0,
    y: 0,
    width: 0,
    height: 0
  });
  const people = useMemo(
    () => displayPeople(story.cast, diffItems),
    [diffItems, story.cast]
  );
  const bonds = useMemo(
    () => displayBonds(story.bonds, diffItems),
    [diffItems, story.bonds]
  );
  const timeline = useMemo(
    () => displayTimeline(story.storyline.timeline, diffItems),
    [diffItems, story.storyline.timeline]
  );
  const layout = useMemo(
    () => createCanvasLayout(people, timeline, story.storyline.opening),
    [people, story.storyline.opening, timeline]
  );
  const indexItems = useMemo(
    () => createCanvasIndex(workspace, people, bonds, timeline),
    [bonds, people, timeline, workspace]
  );

  const syncCanvasViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setCanvasViewport({
      x: viewport.scrollLeft / zoom,
      y: viewport.scrollTop / zoom,
      width: viewport.clientWidth / zoom,
      height: viewport.clientHeight / zoom
    });
  }, [zoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(syncCanvasViewport);
    observer.observe(viewport);
    const frame = window.requestAnimationFrame(syncCanvasViewport);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [layout.height, layout.width, syncCanvasViewport]);

  const zoomAround = (
    nextValue: number,
    pointer?: { clientX: number; clientY: number }
  ) => {
    const viewport = viewportRef.current;
    const nextZoom = clamp(nextValue, MIN_ZOOM, MAX_ZOOM);
    if (!viewport || nextZoom === zoom) return;
    const bounds = viewport.getBoundingClientRect();
    const offsetX = pointer ? pointer.clientX - bounds.left : viewport.clientWidth / 2;
    const offsetY = pointer ? pointer.clientY - bounds.top : viewport.clientHeight / 2;
    const baseX = (viewport.scrollLeft + offsetX) / zoom;
    const baseY = (viewport.scrollTop + offsetY) / zoom;
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        left: baseX * nextZoom - offsetX,
        top: baseY * nextZoom - offsetY
      });
      syncCanvasViewport();
    });
  };

  const fitCanvas = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextZoom = clamp(
      Math.min(
        (viewport.clientWidth - 28) / layout.width,
        (viewport.clientHeight - 28) / layout.height
      ),
      MIN_ZOOM,
      1.15
    );
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      viewport.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      syncCanvasViewport();
    });
  };

  const navigateCanvas = (x: number, y: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({
      left: x * zoom - viewport.clientWidth / 2,
      top: y * zoom - viewport.clientHeight / 2
    });
    window.requestAnimationFrame(syncCanvasViewport);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY || event.deltaX;
      if (!delta) return;
      zoomAround(zoom * Math.exp(-delta * 0.0015), {
        clientX: event.clientX,
        clientY: event.clientY
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  });

  return (
    <section className={`${STORY_PANEL_CLASS} flex h-full min-h-0 min-w-0 flex-col overflow-hidden`}>
      <StorySectionHeader
        title="故事设计画板"
        meta={`${story.cast.length} 人 · ${story.bonds.length} 条关系 · ${story.storyline.timeline.length} 个剧情节点`}
        action={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              icon={<PlusIcon size={10} />}
              onClick={() => onEdit({ kind: "person", key: null })}
            >
              人物
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled || story.cast.length < 2}
              icon={<PlusIcon size={10} />}
              onClick={() => onEdit({ kind: "bond", key: null })}
            >
              关系
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              icon={<PlusIcon size={10} />}
              onClick={() => onEdit({ kind: "timeline", key: null })}
            >
              剧情节点
            </Button>
          </div>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-kumo-line bg-kumo-base px-2 py-1.5">
        <DiffOverlaySummary workspace={workspace} />
        <div className="ml-auto flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-elevated p-0.5">
          <Button
            size="xs"
            shape="square"
            variant="ghost"
            aria-label="缩小画板"
            disabled={zoom <= MIN_ZOOM}
            icon={<MinusIcon size={10} />}
            onClick={() => zoomAround(zoom - 0.1)}
          />
          <span className="w-11 text-center font-mono text-[9px] text-kumo-subtle">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            size="xs"
            shape="square"
            variant="ghost"
            aria-label="放大画板"
            disabled={zoom >= MAX_ZOOM}
            icon={<PlusIcon size={10} />}
            onClick={() => zoomAround(zoom + 0.1)}
          />
          <Button
            size="xs"
            variant="ghost"
            aria-label="适应画布"
            icon={<ArrowsOutIcon size={10} />}
            onClick={fitCanvas}
          >
            适应
          </Button>
        </div>
      </div>

      <div className="story-design-board-grid min-h-0 flex-1">
        <div className="story-design-canvas-shell relative min-h-0 min-w-0 overflow-hidden">
          <div
            ref={viewportRef}
            className="story-design-canvas-viewport h-full min-h-72 min-w-0 overflow-auto bg-kumo-elevated/40"
            aria-label="故事设计画板滚动区域；滚轮缩放"
            onScroll={syncCanvasViewport}
          >
            <StoryCanvas
              workspace={workspace}
              people={people}
              bonds={bonds}
              timeline={timeline}
              layout={layout}
              zoom={zoom}
              onEdit={onEdit}
            />
          </div>
          <StoryMiniMap
            layout={layout}
            people={people}
            bonds={bonds}
            timeline={timeline}
            opening={story.storyline.opening}
            viewport={canvasViewport}
            onNavigate={navigateCanvas}
          />
        </div>

        <aside className="story-canvas-index flex min-h-0 flex-col border-t border-kumo-line bg-kumo-base">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-elevated px-2">
            <span className="font-mono text-[10px] font-semibold text-kumo-subtle">
              画板索引
            </span>
            <Badge variant="secondary">{indexItems.length}</Badge>
          </div>
          <VirtualList
            items={indexItems}
            getItemKey={(item) => item.id}
            estimateSize={() => 58}
            overscan={10}
            aria-label="设计画板节点索引"
            className="min-h-40 flex-1"
            emptyState={<StoryEmpty label="画板中还没有节点" />}
            renderItem={(item) => (
              <button
                type="button"
                disabled={disabled}
                className={`w-full border-b border-kumo-line px-2 py-2 text-left transition-colors hover:bg-kumo-hover disabled:opacity-50 ${storyDiffSurface(item.marker?.action)}`}
                onClick={() => onEdit(item.target)}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-kumo-default">
                    {item.label}
                  </span>
                  {item.marker && (
                    <StoryDiffBadge
                      action={item.marker.action}
                      fields={item.marker.fields}
                    />
                  )}
                </span>
                <span className="mt-1 block truncate font-mono text-[9px] text-kumo-subtle">
                  {item.meta}
                </span>
              </button>
            )}
          />
        </aside>
      </div>
    </section>
  );
}

function StoryCanvas({
  workspace,
  people,
  bonds,
  timeline,
  layout,
  zoom,
  onEdit
}: {
  workspace: StoryWorkspace;
  people: DisplayPerson[];
  bonds: DisplayBond[];
  timeline: DisplayTimeline[];
  layout: CanvasLayout;
  zoom: number;
  onEdit: (target: StoryEditorTarget) => void;
}) {
  const markerId = `story-arrow-${useId().replaceAll(":", "")}`;
  const patternId = `story-grid-${useId().replaceAll(":", "")}`;
  const diffItems = workspace.diff.items;

  return (
    <svg
      role="img"
      aria-label="人物关系与剧情流程设计画板"
      width={layout.width * zoom}
      height={layout.height * zoom}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="block max-w-none text-kumo-default"
    >
      <defs>
        <pattern id={patternId} width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" className="stroke-kumo-line" strokeWidth="0.55" opacity="0.45" fill="none" />
        </pattern>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="3.2"
          markerHeight="3.2"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      <rect width={layout.width} height={layout.height} className="fill-kumo-elevated" />
      <rect width={layout.width} height={layout.height} fill={`url(#${patternId})`} />

      <text x="24" y="30" className="fill-kumo-default" fontSize="12" fontWeight="650">
        人物关系区
      </text>
      <text x="24" y="47" className="fill-kumo-subtle" fontFamily="ui-monospace, monospace" fontSize="8.5">
        点击人物节点或关系边进入统一编辑器
      </text>
      <RelationshipLayer
        people={people}
        bonds={bonds}
        positions={layout.people}
        diffItems={diffItems}
        markerId={markerId}
        onEdit={onEdit}
      />

      <line x1="0" y1={RELATION_HEIGHT} x2={layout.width} y2={RELATION_HEIGHT} className="stroke-kumo-line" strokeWidth="1.2" />
      <text x="24" y={RELATION_HEIGHT + 30} className="fill-kumo-default" fontSize="12" fontWeight="650">
        剧情流程区
      </text>
      <text x="24" y={RELATION_HEIGHT + 47} className="fill-kumo-subtle" fontFamily="ui-monospace, monospace" fontSize="8.5">
        自上而下按 next / routes 排布，虚线为 waitFor，并行容器内每行是独立事件
      </text>
      <StoryFlowLayer
        workspace={workspace}
        timeline={timeline}
        layout={layout}
        markerId={markerId}
        onEdit={onEdit}
      />
    </svg>
  );
}

function StoryMiniMap({
  layout,
  people,
  bonds,
  timeline,
  opening,
  viewport,
  onNavigate
}: {
  layout: CanvasLayout;
  people: DisplayPerson[];
  bonds: DisplayBond[];
  timeline: DisplayTimeline[];
  opening: string;
  viewport: CanvasViewport;
  onNavigate: (x: number, y: number) => void;
}) {
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const flowEdges = useMemo(
    () => createFlowEdges(timeline, layout, opening, []),
    [layout, opening, timeline]
  );
  const visibleViewport = {
    x: clamp(viewport.x, 0, Math.max(0, layout.width - viewport.width)),
    y: clamp(viewport.y, 0, Math.max(0, layout.height - viewport.height)),
    width: Math.min(layout.width, Math.max(0, viewport.width)),
    height: Math.min(layout.height, Math.max(0, viewport.height))
  };

  const pointerPosition = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * layout.width,
      y: ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * layout.height
    };
  };

  const moveViewport = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = pointerPosition(event);
    onNavigate(point.x - dragOffset.current.x, point.y - dragOffset.current.y);
  };

  return (
    <div className="story-minimap absolute bottom-3 right-3 z-10 overflow-hidden rounded-md border border-kumo-line bg-kumo-base/95 shadow-lg backdrop-blur-sm">
      <div className="border-b border-kumo-line px-2 py-1 font-mono text-[8px] font-semibold text-kumo-subtle">
        MINIMAP · 点击 / 拖动
      </div>
      <svg
        role="img"
        aria-label="故事画板小地图；点击或拖动平移视口"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="none"
        className="block h-28 w-44 cursor-crosshair touch-none bg-kumo-elevated"
        onPointerDown={(event) => {
          const point = pointerPosition(event);
          const insideViewport =
            point.x >= visibleViewport.x &&
            point.x <= visibleViewport.x + visibleViewport.width &&
            point.y >= visibleViewport.y &&
            point.y <= visibleViewport.y + visibleViewport.height;
          dragOffset.current = insideViewport
            ? {
                x: point.x - (visibleViewport.x + visibleViewport.width / 2),
                y: point.y - (visibleViewport.y + visibleViewport.height / 2)
              }
            : { x: 0, y: 0 };
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          moveViewport(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) moveViewport(event);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <rect width={layout.width} height={layout.height} className="fill-kumo-elevated" />
        <line x1="0" y1={RELATION_HEIGHT} x2={layout.width} y2={RELATION_HEIGHT} className="stroke-kumo-line" strokeWidth="8" />
        {bonds.map((entry) => {
          const source = layout.people.get(entry.bond.source);
          const target = layout.people.get(entry.bond.target);
          if (!source || !target) return null;
          return (
            <g key={entry.key}>
              <line
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className="stroke-kumo-elevated"
                strokeWidth="4"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className="story-stroke-default"
                strokeWidth="1.5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                opacity="0.72"
              />
            </g>
          );
        })}
        {people.map((entry) => {
          const position = layout.people.get(entry.person.key);
          if (!position) return null;
          return (
            <circle
              key={entry.person.key}
              cx={position.x}
              cy={position.y}
              r="18"
              className="fill-kumo-accent"
            />
          );
        })}
        {flowEdges.map((edge) => {
          const path = flowPath(edge.from, edge.to, edge.kind === "dependency");
          const strokeClass = edge.kind === "dependency"
            ? "stroke-kumo-warning"
            : edge.kind === "route"
              ? "stroke-kumo-brand"
              : "story-stroke-default";
          return (
            <g key={edge.id}>
              <path
                d={path}
                fill="none"
                className="stroke-kumo-elevated"
                strokeWidth="4.5"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={path}
                fill="none"
                className={strokeClass}
                strokeWidth={edge.kind === "dependency" ? 1.7 : 1.8}
                strokeDasharray={edge.kind === "dependency" ? "5 4" : undefined}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                opacity={edge.kind === "dependency" ? 0.95 : 0.78}
              />
            </g>
          );
        })}
        <rect
          x={layout.opening.x}
          y={layout.opening.y}
          width={layout.opening.width}
          height={layout.opening.height}
          rx="8"
          className="fill-kumo-accent"
          opacity="0.58"
        />
        {timeline.map((entry) => {
          const box = layout.nodes.get(entry.node.key);
          if (!box) return null;
          return (
            <rect
              key={entry.node.key}
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx="8"
              className={entry.node.parallel ? "fill-kumo-warning" : "fill-kumo-accent"}
              opacity="0.8"
            />
          );
        })}
        <rect
          x={visibleViewport.x}
          y={visibleViewport.y}
          width={visibleViewport.width}
          height={visibleViewport.height}
          className="fill-kumo-accent stroke-kumo-brand"
          fillOpacity="0.12"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

function RelationshipLayer({
  people,
  bonds,
  positions,
  diffItems,
  markerId,
  onEdit
}: {
  people: DisplayPerson[];
  bonds: DisplayBond[];
  positions: Map<string, Point>;
  diffItems: StoryDiffItem[];
  markerId: string;
  onEdit: (target: StoryEditorTarget) => void;
}) {
  if (people.length === 0) {
    return (
      <g className="fill-kumo-inactive">
        <UsersThreeIcon x={338} y={157} size={18} />
        <text x="365" y="170" fontFamily="ui-monospace, monospace" fontSize="10">
          添加人物后生成关系图
        </text>
      </g>
    );
  }

  return (
    <g>
      {bonds.map((entry) => {
        const source = positions.get(entry.bond.source);
        const target = positions.get(entry.bond.target);
        if (!source || !target) return null;
        const marker = storyDiffMarker(diffItems, "bonds", entry.key);
        const midpoint = {
          x: (source.x + target.x) / 2,
          y: (source.y + target.y) / 2
        };
        const strokeClass = diffStroke(marker?.action, "story-stroke-default");
        return (
          <g
            key={entry.key}
            role="button"
            tabIndex={0}
            aria-label={`编辑关系 ${entry.key}`}
            className="cursor-pointer outline-none"
            onClick={() => onEdit({ kind: "bond", key: entry.key })}
            onKeyDown={(event) => activateFromKeyboard(event, () => onEdit({ kind: "bond", key: entry.key }))}
          >
            <line
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke="transparent"
              strokeWidth="18"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              className="stroke-kumo-elevated"
              strokeWidth="6"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
            <line
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              className={strokeClass}
              strokeWidth={marker ? 3.2 : 2.4}
              strokeDasharray={marker?.action === "removed" ? "7 5" : undefined}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              markerEnd={`url(#${markerId})`}
              opacity={marker ? 1 : 0.72}
              pointerEvents="none"
            />
            <rect x={midpoint.x - 39} y={midpoint.y - 11} width="78" height={marker ? 27 : 20} rx="4" className="fill-kumo-base stroke-kumo-line" />
            <text x={midpoint.x} y={midpoint.y + 3} textAnchor="middle" className="fill-kumo-subtle" fontFamily="ui-monospace, monospace" fontSize="8">
              {RELATION_LABELS[entry.bond.relation]}
            </text>
            {marker && (
              <text x={midpoint.x} y={midpoint.y + 13} textAnchor="middle" className={diffFill(marker.action)} fontFamily="ui-monospace, monospace" fontSize="6.5">
                {diffText(marker)}
              </text>
            )}
          </g>
        );
      })}

      {people.map((entry) => {
        const person = entry.person;
        const position = positions.get(person.key)!;
        const marker = storyDiffMarker(diffItems, "cast", person.key);
        return (
          <g
            key={person.key}
            role="button"
            tabIndex={0}
            aria-label={`编辑人物 ${person.name}`}
            className="cursor-pointer outline-none"
            onClick={() => onEdit({ kind: "person", key: person.key })}
            onKeyDown={(event) => activateFromKeyboard(event, () => onEdit({ kind: "person", key: person.key }))}
          >
            <rect
              x={position.x - 68}
              y={position.y - 29}
              width="136"
              height="58"
              rx="6"
              className={`fill-kumo-base ${diffStroke(marker?.action, "stroke-kumo-line")}`}
              strokeWidth={marker ? 2.3 : 1.2}
              strokeDasharray={marker?.action === "removed" ? "5 4" : undefined}
            />
            <circle cx={position.x - 49} cy={position.y} r="9" className={marker ? diffFill(marker.action) : "fill-kumo-tint"} />
            <text x={position.x - 34} y={position.y - 5} className="fill-kumo-default" fontSize="10" fontWeight="600">
              {truncate(person.name, 9)}
            </text>
            <text x={position.x - 34} y={position.y + 11} className="fill-kumo-subtle" fontFamily="ui-monospace, monospace" fontSize="7.5">
              {truncate(person.identity, 17)}
            </text>
            {marker && (
              <text x={position.x} y={position.y + 42} textAnchor="middle" className={diffFill(marker.action)} fontFamily="ui-monospace, monospace" fontSize="7.5">
                {diffText(marker)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function StoryFlowLayer({
  workspace,
  timeline,
  layout,
  markerId,
  onEdit
}: {
  workspace: StoryWorkspace;
  timeline: DisplayTimeline[];
  layout: CanvasLayout;
  markerId: string;
  onEdit: (target: StoryEditorTarget) => void;
}) {
  const diffItems = workspace.diff.items;
  const openingMarker = storyDiffMarker(diffItems, "story", "storyline");
  const openingBox = layout.opening;
  const edges = createFlowEdges(timeline, layout, workspace.story.storyline.opening, diffItems);

  return (
    <g>
      <g
        role="button"
        tabIndex={0}
        aria-label={`编辑开场入口 ${workspace.story.storyline.opening}`}
        className="cursor-pointer outline-none"
        onClick={() => onEdit({ kind: "opening" })}
        onKeyDown={(event) => activateFromKeyboard(event, () => onEdit({ kind: "opening" }))}
      >
        <rect
          x={openingBox.x}
          y={openingBox.y}
          width={openingBox.width}
          height={openingBox.height}
          rx="8"
          className={`fill-kumo-base ${diffStroke(openingMarker?.action, "stroke-kumo-brand")}`}
          strokeWidth={openingMarker ? 2.4 : 1.4}
        />
        <text x={openingBox.x + 15} y={openingBox.y + 21} className="fill-kumo-accent" fontFamily="ui-monospace, monospace" fontSize="8" fontWeight="700">
          OPENING
        </text>
        <text x={openingBox.x + 15} y={openingBox.y + 40} className="fill-kumo-default" fontFamily="ui-monospace, monospace" fontSize="9.5">
          {truncate(workspace.story.storyline.opening, 14)}
        </text>
        {openingMarker && (
          <text x={openingBox.x + openingBox.width + 9} y={openingBox.y + openingBox.height / 2 + 2} className={diffFill(openingMarker.action)} fontFamily="ui-monospace, monospace" fontSize="7">
            {diffText(openingMarker)}
          </text>
        )}
      </g>

      {edges.map((edge) => (
        <FlowEdgeView key={edge.id} edge={edge} markerId={markerId} onEdit={onEdit} />
      ))}

      {timeline.map((entry) => {
        const node = entry.node;
        const box = layout.nodes.get(node.key);
        if (!box) return null;
        const marker = storyDiffMarker(diffItems, "timeline", node.key);
        const target = { kind: "timeline", key: node.key } as const;
        return (
          <g
            key={node.key}
            role="button"
            tabIndex={0}
            aria-label={`编辑剧情节点 ${node.key}`}
            className="cursor-pointer outline-none"
            onClick={() => onEdit(target)}
            onKeyDown={(event) => activateFromKeyboard(event, () => onEdit(target))}
          >
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx="7"
              className={`fill-kumo-base ${diffStroke(marker?.action, "stroke-kumo-line")}`}
              strokeWidth={marker ? 2.4 : 1.3}
              strokeDasharray={marker?.action === "removed" ? "6 4" : undefined}
            />
            <rect x={box.x} y={box.y} width={box.width} height="31" rx="7" className="fill-kumo-tint" opacity="0.72" />
            <line x1={box.x} y1={box.y + 31} x2={box.x + box.width} y2={box.y + 31} className="stroke-kumo-line" />
            <text x={box.x + 10} y={box.y + 19} className="fill-kumo-accent" fontFamily="ui-monospace, monospace" fontSize="9.5" fontWeight="650">
              {truncate(node.key, 20)}
            </text>
            <text x={box.x + box.width - 10} y={box.y + 19} textAnchor="end" className="fill-kumo-subtle" fontFamily="ui-monospace, monospace" fontSize="8">
              {node.at} · L{String((layout.ranks.get(node.key) ?? 0) + 1).padStart(2, "0")}
            </text>

            {node.parallel ? (
              <ParallelNodeBody node={node} box={box} layout={layout} marker={marker} />
            ) : (
              <NormalNodeBody node={node} box={box} marker={marker} />
            )}
          </g>
        );
      })}
    </g>
  );
}

function NormalNodeBody({
  node,
  box,
  marker
}: {
  node: TimelineNode;
  box: NodeBox;
  marker?: StoryDiffMarker;
}) {
  return (
    <g>
      <text x={box.x + 10} y={box.y + 50} className="fill-kumo-default" fontSize="9.5">
        {truncate(node.event ?? "未命名事件", 26)}
      </text>
      <text x={box.x + 10} y={box.y + 67} className="fill-kumo-subtle" fontFamily="ui-monospace, monospace" fontSize="7.5">
        {node.actor ? `actor / ${truncate(node.actor, 18)}` : node.actors?.length ? `actors / ${node.actors.length}` : "actor / —"}
      </text>
      <text x={box.x + 10} y={box.y + 84} className="fill-kumo-inactive" fontFamily="ui-monospace, monospace" fontSize="7.5">
        {node.routes ? `${Object.keys(node.routes).length} ROUTES` : node.next ? `NEXT / ${truncate(node.next, 15)}` : node.end ? "END" : "NO EXIT"}
      </text>
      {marker && (
        <text x={box.x + 10} y={box.y + box.height - 8} className={diffFill(marker.action)} fontFamily="ui-monospace, monospace" fontSize="7">
          {diffText(marker)}
        </text>
      )}
    </g>
  );
}

function ParallelNodeBody({
  node,
  box,
  layout,
  marker
}: {
  node: TimelineNode;
  box: NodeBox;
  layout: CanvasLayout;
  marker?: StoryDiffMarker;
}) {
  return (
    <g>
      <text x={box.x + 10} y={box.y + 48} className="fill-kumo-warning" fontFamily="ui-monospace, monospace" fontSize="7.5" fontWeight="700">
        PARALLEL · {node.parallel?.length ?? 0} 条泳道
      </text>
      {node.parallel?.map((event) => {
        const eventBox = layout.parallelEvents.get(event.key);
        if (!eventBox) return null;
        return (
          <g key={event.key}>
            <rect x={eventBox.x} y={eventBox.y} width={eventBox.width} height={eventBox.height} rx="4" className="fill-kumo-elevated stroke-kumo-line" />
            <circle cx={eventBox.x + 9} cy={eventBox.y + 11} r="3" className="fill-kumo-warning" />
            <text x={eventBox.x + 17} y={eventBox.y + 13} className="fill-kumo-default" fontFamily="ui-monospace, monospace" fontSize="7.5">
              {truncate(event.key, 13)} · {truncate(event.actor, 10)}
            </text>
            <text x={eventBox.x + 8} y={eventBox.y + 26} className="fill-kumo-subtle" fontSize="7.2">
              {truncate(event.event, 24)}
            </text>
          </g>
        );
      })}
      {marker && (
        <text x={box.x + 10} y={box.y + box.height - 7} className={diffFill(marker.action)} fontFamily="ui-monospace, monospace" fontSize="7">
          {diffText(marker)}
        </text>
      )}
    </g>
  );
}

interface FlowEdge {
  id: string;
  from: Point;
  to: Point;
  label?: string;
  kind: "opening" | "next" | "route" | "dependency" | "end";
  target: StoryEditorTarget;
  action?: StoryDiffAction;
  fields?: string[];
}

function FlowEdgeView({
  edge,
  markerId,
  onEdit
}: {
  edge: FlowEdge;
  markerId: string;
  onEdit: (target: StoryEditorTarget) => void;
}) {
  const path = flowPath(edge.from, edge.to, edge.kind === "dependency");
  const strokeClass = diffStroke(
    edge.action,
    edge.kind === "dependency"
      ? "stroke-kumo-warning"
      : edge.kind === "route"
        ? "stroke-kumo-brand"
        : "story-stroke-default"
  );
  const labelPoint = {
    x: (edge.from.x + edge.to.x) / 2,
    y: (edge.from.y + edge.to.y) / 2 - 7
  };
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`编辑${edge.kind === "route" ? "分支" : edge.kind === "dependency" ? "依赖" : "流程边"}${edge.label ? ` ${edge.label}` : ""}`}
      className="cursor-pointer outline-none"
      onClick={() => onEdit(edge.target)}
      onKeyDown={(event) => activateFromKeyboard(event, () => onEdit(edge.target))}
    >
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth="18"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path}
        fill="none"
        className="stroke-kumo-elevated"
        strokeWidth="6"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      <path
        d={path}
        fill="none"
        className={strokeClass}
        strokeWidth={edge.action ? 3.2 : edge.kind === "dependency" ? 2.6 : 2.5}
        strokeDasharray={edge.kind === "dependency" ? "8 6" : edge.action === "removed" ? "7 5" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        markerEnd={edge.kind === "end" ? undefined : `url(#${markerId})`}
        opacity={edge.action ? 1 : edge.kind === "dependency" ? 0.96 : edge.kind === "route" ? 0.88 : 0.76}
        pointerEvents="none"
      />
      {edge.kind === "end" && (
        <g pointerEvents="none">
          <circle
            cx={edge.to.x}
            cy={edge.to.y}
            r="10"
            className="fill-kumo-base story-stroke-default"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={edge.to.x}
            cy={edge.to.y}
            r="5"
            className="fill-kumo-danger stroke-kumo-base"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
      {(edge.label || edge.fields?.length) && (
        <g>
          <rect x={labelPoint.x - 42} y={labelPoint.y - 10} width="84" height="20" rx="4" className="fill-kumo-base stroke-kumo-line" />
          <text x={labelPoint.x} y={labelPoint.y + 2} textAnchor="middle" className={edge.action ? diffFill(edge.action) : "fill-kumo-subtle"} fontFamily="ui-monospace, monospace" fontSize="7">
            {truncate(edge.label ?? edge.fields?.join(", ") ?? "", 20)}
          </text>
        </g>
      )}
    </g>
  );
}

function createCanvasLayout(
  people: DisplayPerson[],
  timeline: DisplayTimeline[],
  opening: string
): CanvasLayout {
  const tree = createStoryTreeLayout(
    timeline.map((entry) => entry.node),
    opening,
    FLOW_START_Y
  );
  const peoplePositions = new Map<string, Point>();
  const relationCenter = { x: tree.width / 2, y: 188 };
  const radiusX = people.length < 3 ? 165 : Math.min(280, tree.width / 2 - 110);
  const radiusY = people.length < 3 ? 76 : 105;
  people.forEach((entry, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, people.length) - Math.PI / 2;
    peoplePositions.set(entry.person.key, {
      x: relationCenter.x + Math.cos(angle) * radiusX,
      y: relationCenter.y + Math.sin(angle) * radiusY
    });
  });

  return {
    ...tree,
    people: peoplePositions
  };
}

function createFlowEdges(
  timeline: DisplayTimeline[],
  layout: CanvasLayout,
  opening: string,
  diffItems: StoryDiffItem[]
): FlowEdge[] {
  const edges: FlowEdge[] = [];
  const openingNodeBox = layout.nodes.get(opening);
  const openingMarker = storyDiffMarker(diffItems, "story", "storyline");
  if (openingNodeBox) {
    edges.push({
      id: `opening:${opening}`,
      from: {
        x: layout.opening.x + layout.opening.width / 2,
        y: layout.opening.y + layout.opening.height
      },
      to: { x: openingNodeBox.x + openingNodeBox.width / 2, y: openingNodeBox.y },
      kind: "opening",
      target: { kind: "opening" },
      action: openingMarker?.action,
      fields: openingMarker?.fields
    });
  }

  timeline.forEach((entry) => {
    const node = entry.node;
    const box = layout.nodes.get(node.key);
    if (!box) return;
    const marker = storyDiffMarker(diffItems, "timeline", node.key);
    const fieldAction = (field: string) =>
      marker && (marker.action !== "modified" || marker.fields.includes(field))
        ? marker.action
        : undefined;
    const target = { kind: "timeline", key: node.key } as const;
    const from = { x: box.x + box.width / 2, y: box.y + box.height };

    if (node.next) {
      const nextBox = layout.nodes.get(node.next);
      if (nextBox) {
        edges.push({
          id: `${node.key}:next:${node.next}`,
          from,
          to: { x: nextBox.x + nextBox.width / 2, y: nextBox.y },
          kind: "next",
          target,
          action: fieldAction("next"),
          fields: fieldAction("next") ? ["next"] : undefined
        });
      }
    }

    const routes = Object.entries(node.routes ?? {});
    routes.forEach(([condition, destination], index) => {
      const destinationBox = layout.nodes.get(destination);
      if (!destinationBox) return;
      edges.push({
        id: `${node.key}:route:${condition}:${destination}`,
        from: {
          x: box.x + (box.width * (index + 1)) / (routes.length + 1),
          y: box.y + box.height
        },
        to: { x: destinationBox.x + destinationBox.width / 2, y: destinationBox.y },
        label: condition,
        kind: "route",
        target,
        action: fieldAction("routes"),
        fields: fieldAction("routes") ? ["routes"] : undefined
      });
    });

    node.waitFor?.forEach((dependency) => {
      const dependencyBox = layout.parallelEvents.get(dependency) ?? layout.nodes.get(dependency);
      if (!dependencyBox) return;
      edges.push({
        id: `${node.key}:waitFor:${dependency}`,
        from: {
          x: dependencyBox.x + dependencyBox.width / 2,
          y: dependencyBox.y + dependencyBox.height
        },
        to: { x: box.x + box.width / 2, y: box.y },
        label: `waitFor ${dependency}`,
        kind: "dependency",
        target,
        action: fieldAction("waitFor"),
        fields: fieldAction("waitFor") ? ["waitFor"] : undefined
      });
    });

    if (node.end) {
      edges.push({
        id: `${node.key}:end`,
        from,
        to: { x: from.x, y: box.y + box.height + 54 },
        label: "END",
        kind: "end",
        target,
        action: fieldAction("end"),
        fields: fieldAction("end") ? ["end"] : undefined
      });
    }
  });
  return edges;
}

function createCanvasIndex(
  workspace: StoryWorkspace,
  people: DisplayPerson[],
  bonds: DisplayBond[],
  timeline: DisplayTimeline[]
): CanvasIndexItem[] {
  const diffItems = workspace.diff.items;
  return [
    {
      id: "opening:storyline",
      label: "开场入口",
      meta: workspace.story.storyline.opening,
      target: { kind: "opening" } as const,
      marker: storyDiffMarker(diffItems, "story", "storyline")
    },
    ...people.map((entry) => ({
      id: `person:${entry.person.key}`,
      label: entry.person.name,
      meta: `人物 · ${entry.person.key} · ${entry.person.identity}`,
      target: { kind: "person", key: entry.person.key } as const,
      marker: storyDiffMarker(diffItems, "cast", entry.person.key)
    })),
    ...bonds.map((entry) => ({
      id: `bond:${entry.key}`,
      label: `${entry.bond.source} → ${entry.bond.target}`,
      meta: `关系 · ${RELATION_LABELS[entry.bond.relation]}`,
      target: { kind: "bond", key: entry.key } as const,
      marker: storyDiffMarker(diffItems, "bonds", entry.key)
    })),
    ...timeline.map((entry) => ({
      id: `timeline:${entry.node.key}`,
      label: entry.node.key,
      meta: entry.node.parallel
        ? `并行容器 · ${entry.node.parallel.length} 条泳道`
        : `${entry.node.at} · ${entry.node.event ?? "剧情事件"}`,
      target: { kind: "timeline", key: entry.node.key } as const,
      marker: storyDiffMarker(diffItems, "timeline", entry.node.key)
    }))
  ];
}

function DiffOverlaySummary({ workspace }: { workspace: StoryWorkspace }) {
  if (!workspace.dirty) {
    return (
      <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-kumo-success">
        <GitDiffIcon size={13} />
        <span className="truncate">画板与 {workspace.branch} 一致</span>
      </div>
    );
  }
  const counts = workspace.diff.items.reduce(
    (result, item) => {
      const action = item.action ?? item.type ?? "modified";
      result[action] += 1;
      return result;
    },
    { added: 0, modified: 0, removed: 0 }
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[10px] text-kumo-warning">
      <GitDiffIcon size={13} />
      <span>业务 Diff 已叠加到节点和边</span>
      <StoryDiffBadge action="added" fields={[String(counts.added)]} />
      <StoryDiffBadge action="modified" fields={[String(counts.modified)]} />
      <StoryDiffBadge action="removed" fields={[String(counts.removed)]} />
    </div>
  );
}

function displayPeople(cast: StoryPerson[], diffItems: StoryDiffItem[]): DisplayPerson[] {
  const people = cast.map((person) => ({ person, removed: false }));
  for (const item of diffItems) {
    if (
      (item.category ?? item.scope) === "cast" &&
      (item.action ?? item.type) === "removed" &&
      item.before &&
      typeof item.before === "object"
    ) {
      const person = item.before as StoryPerson;
      if (!people.some((entry) => entry.person.key === person.key)) {
        people.push({ person, removed: true });
      }
    }
  }
  return people;
}

function displayBonds(current: StoryBond[], diffItems: StoryDiffItem[]): DisplayBond[] {
  const bonds = current.map((bond, index) => ({
    bond,
    key: storyBondKey(current, index),
    removed: false
  }));
  for (const item of diffItems) {
    if (
      (item.category ?? item.scope) === "bonds" &&
      (item.action ?? item.type) === "removed" &&
      item.before &&
      typeof item.before === "object"
    ) {
      const key = item.label ?? item.path?.split("/").at(-1);
      if (key && !bonds.some((entry) => entry.key === key)) {
        bonds.push({ bond: item.before as StoryBond, key, removed: true });
      }
    }
  }
  return bonds;
}

function displayTimeline(current: TimelineNode[], diffItems: StoryDiffItem[]): DisplayTimeline[] {
  const timeline = current.map((node) => ({ node, removed: false }));
  for (const item of diffItems) {
    if (
      (item.category ?? item.scope) === "timeline" &&
      (item.action ?? item.type) === "removed" &&
      item.before &&
      typeof item.before === "object"
    ) {
      const node = item.before as TimelineNode;
      if (!timeline.some((entry) => entry.node.key === node.key)) {
        timeline.push({ node, removed: true });
      }
    }
  }
  return timeline;
}

function flowPath(from: Point, to: Point, dependency: boolean): string {
  const verticalDistance = to.y - from.y;
  if (verticalDistance <= 12) {
    const sideX = Math.max(from.x, to.x) + (dependency ? 58 : 42);
    return `M ${from.x} ${from.y} C ${sideX} ${from.y + 24}, ${sideX} ${to.y - 24}, ${to.x} ${to.y}`;
  }
  const middleY = from.y + verticalDistance / 2;
  const offset = dependency ? (to.x >= from.x ? 24 : -24) : 0;
  return `M ${from.x} ${from.y} C ${from.x + offset} ${middleY}, ${to.x - offset} ${middleY}, ${to.x} ${to.y}`;
}

function diffStroke(action?: StoryDiffAction, fallback = "stroke-kumo-inactive"): string {
  return action === "added"
    ? "stroke-kumo-success"
    : action === "removed"
      ? "stroke-kumo-danger"
      : action === "modified"
        ? "stroke-kumo-warning"
        : fallback;
}

function diffFill(action: StoryDiffAction): string {
  return action === "added"
    ? "fill-kumo-success"
    : action === "removed"
      ? "fill-kumo-danger"
      : "fill-kumo-warning";
}

function diffText(marker: StoryDiffMarker): string {
  const prefix = marker.action === "added" ? "+" : marker.action === "removed" ? "−" : "~";
  return `${prefix} ${marker.fields.join("/") || (marker.action === "added" ? "新增" : marker.action === "removed" ? "删除" : "修改")}`;
}

function activateFromKeyboard(
  event: { key: string; preventDefault: () => void },
  action: () => void
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
