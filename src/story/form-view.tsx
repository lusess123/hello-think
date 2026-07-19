import {
  FlagIcon,
  FlowArrowIcon,
  GitDiffIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserIcon,
  XIcon
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import {
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { VirtualList } from "../components/virtual-list";
import type { StoryWorkspace } from "./types";
import type { StoryEditorTarget } from "./ui-model";
import {
  buildStoryFormItems,
  countStoryDiff,
  filterStoryFormItems,
  type StoryFormFilter,
  type StoryFormItem,
  type StoryFormKind
} from "./form-view-model";
import {
  StoryDiffBadge,
  StoryEmpty,
  StorySectionHeader,
  STORY_INPUT_CLASS,
  STORY_PANEL_CLASS,
  storyDiffSurface
} from "./story-ui";

export interface FormViewProps {
  workspace: StoryWorkspace;
  disabled: boolean;
  onEdit: (target: StoryEditorTarget) => void;
}

const FILTERS: ReadonlyArray<{
  id: StoryFormFilter;
  label: string;
}> = [
  { id: "all", label: "全部" },
  { id: "opening", label: "开场" },
  { id: "person", label: "人物" },
  { id: "bond", label: "关系" },
  { id: "timeline", label: "剧情" }
];

export function FormView({ workspace, disabled, onEdit }: FormViewProps) {
  const [filter, setFilter] = useState<StoryFormFilter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const items = useMemo(() => buildStoryFormItems(workspace), [workspace]);
  const visibleItems = useMemo(
    () => filterStoryFormItems(items, filter, deferredQuery),
    [deferredQuery, filter, items]
  );
  const kindCounts = useMemo(() => countKinds(items), [items]);
  const renderItem = useCallback(
    (item: StoryFormItem) => (
      <FormEntityCard item={item} disabled={disabled} onEdit={onEdit} />
    ),
    [disabled, onEdit]
  );
  const story = workspace.story;

  return (
    <section
      className={`${STORY_PANEL_CLASS} flex h-full min-h-0 min-w-0 flex-col overflow-hidden`}
    >
      <StorySectionHeader
        title="结构化表单"
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
        <FormDiffSummary workspace={workspace} />
        <div className="relative ml-auto block w-full min-w-48 sm:w-64">
          <MagnifyingGlassIcon
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-kumo-subtle"
          />
          <input
            type="search"
            aria-label="搜索故事实体"
            value={query}
            placeholder="搜索名称、标识、事件或字段"
            className={`${STORY_INPUT_CLASS} h-7 py-1 pl-7 pr-7`}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              aria-label="清空搜索"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-kumo-subtle hover:bg-kumo-fill-hover hover:text-kumo-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-kumo-focus"
              onClick={() => setQuery("")}
            >
              <XIcon size={11} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-kumo-line bg-kumo-elevated px-2 py-1">
        <div
          role="group"
          aria-label="按实体类型筛选"
          className="flex items-center gap-1"
        >
          {FILTERS.map((option) => {
            const active = filter === option.id;
            const count = option.id === "all" ? items.length : kindCounts[option.id];
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                className={`flex h-6 shrink-0 items-center gap-1 rounded px-2 font-mono text-[9px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-kumo-focus ${
                  active
                    ? "bg-kumo-tint text-kumo-default"
                    : "text-kumo-subtle hover:bg-kumo-fill-hover hover:text-kumo-default"
                }`}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
                <span className="min-w-4 rounded-sm bg-kumo-base px-1 text-center text-[8px] text-kumo-subtle">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <span className="ml-auto shrink-0 font-mono text-[9px] text-kumo-subtle">
          显示 {visibleItems.length} / {items.length}
        </span>
      </div>

      <VirtualList
        items={visibleItems}
        getItemKey={(item) => item.id}
        estimateSize={() => 92}
        overscan={10}
        aria-label="故事结构化实体列表"
        className="min-h-0 flex-1 bg-kumo-elevated/35"
        itemClassName="px-2 pt-2"
        emptyState={
          <StoryEmpty
            label={
              deferredQuery
                ? `没有匹配“${deferredQuery}”的实体`
                : "当前类型下没有实体"
            }
          />
        }
        renderItem={renderItem}
      />
    </section>
  );
}

function FormEntityCard({
  item,
  disabled,
  onEdit
}: {
  item: StoryFormItem;
  disabled: boolean;
  onEdit: (target: StoryEditorTarget) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${item.removed ? "查看已删除" : "编辑"}${item.kindLabel} ${item.title}`}
      className={`group w-full rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-kumo-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus disabled:cursor-not-allowed disabled:opacity-50 ${storyDiffSurface(item.marker?.action)}`}
      onClick={() => onEdit(item.target)}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded border border-kumo-line bg-kumo-elevated px-1.5 font-mono text-[8px] font-semibold uppercase tracking-[0.05em] text-kumo-subtle">
          <KindIcon kind={item.kind} />
          {item.kindLabel}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-semibold text-kumo-default">
            {item.title}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9px] text-kumo-subtle">
            {item.subtitle}
          </span>
        </span>
        {item.marker ? (
          <StoryDiffBadge
            action={item.marker.action}
            fields={diffFields(item.marker.fields)}
          />
        ) : null}
      </span>

      <span className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-kumo-line/70 pt-1.5 lg:grid-cols-4">
        {item.facts.map((fact) => (
          <span key={fact.label} className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.06em] text-kumo-subtle">
              {fact.label}
            </span>
            <span className="truncate font-mono text-[9px] text-kumo-default">
              {fact.value}
            </span>
          </span>
        ))}
      </span>
    </button>
  );
}

function FormDiffSummary({ workspace }: { workspace: StoryWorkspace }) {
  const counts = useMemo(
    () => countStoryDiff(workspace.diff.items),
    [workspace.diff.items]
  );
  if (!workspace.dirty) {
    return (
      <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-kumo-success">
        <GitDiffIcon size={13} />
        <span className="truncate">累计业务 Diff · 与 {workspace.branch} 一致</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[10px] text-kumo-warning">
      <GitDiffIcon size={13} />
      <span>累计业务 Diff · {counts.total} 项</span>
      <StoryDiffBadge action="added" fields={[String(counts.added)]} />
      <StoryDiffBadge action="modified" fields={[String(counts.modified)]} />
      <StoryDiffBadge action="removed" fields={[String(counts.removed)]} />
    </div>
  );
}

function KindIcon({ kind }: { kind: StoryFormKind }): ReactNode {
  if (kind === "opening") return <FlagIcon size={10} />;
  if (kind === "person") return <UserIcon size={10} />;
  if (kind === "bond") return <LinkIcon size={10} />;
  return <FlowArrowIcon size={10} />;
}

function countKinds(items: readonly StoryFormItem[]): Record<StoryFormKind, number> {
  const counts: Record<StoryFormKind, number> = {
    opening: 0,
    person: 0,
    bond: 0,
    timeline: 0
  };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

function diffFields(fields: readonly string[]): string[] {
  if (fields.length <= 2) return [...fields];
  return [...fields.slice(0, 2), `+${fields.length - 2}`];
}
