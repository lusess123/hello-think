import { useCallback, useMemo, useRef } from "react";
import type {
  AriaRole,
  CSSProperties,
  Key,
  ReactNode
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const DEFAULT_FOLLOW_THRESHOLD = 48;
const BOTTOM_INITIAL_OFFSET = Number.MAX_SAFE_INTEGER;

export interface VirtualListFollowOptions {
  anchorTo: "start" | "end";
  followOnAppend: false | "auto";
  initialOffset: number;
  scrollEndThreshold: number;
}

/**
 * Keeps the bottom-follow behavior deterministic and independently testable.
 * TanStack only follows appended items when the viewport was already near the
 * bottom; `anchorTo: "end"` also keeps streaming, dynamically measured rows
 * pinned without pulling a user back down after they scroll upward.
 */
export function getVirtualListFollowOptions(
  followBottom: boolean,
  threshold = DEFAULT_FOLLOW_THRESHOLD
): VirtualListFollowOptions {
  const scrollEndThreshold = Number.isFinite(threshold)
    ? Math.max(0, threshold)
    : DEFAULT_FOLLOW_THRESHOLD;

  if (!followBottom) {
    return {
      anchorTo: "start",
      followOnAppend: false,
      initialOffset: 0,
      scrollEndThreshold
    };
  }

  return {
    anchorTo: "end",
    followOnAppend: "auto",
    initialOffset: BOTTOM_INITIAL_OFFSET,
    scrollEndThreshold
  };
}

export interface VirtualListProps<T> {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  getItemKey: (item: T, index: number) => Key;
  estimateSize: (index: number) => number;
  overscan?: number;
  className?: string;
  windowClassName?: string;
  itemClassName?: string;
  emptyState?: ReactNode;
  followBottom?: boolean;
  followThreshold?: number;
  role?: AriaRole;
  itemRole?: AriaRole;
  tabIndex?: number;
  style?: CSSProperties;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-busy"?: boolean;
}

/**
 * A vertically scrolling, dynamically measured list. The outer element owns
 * scrolling while the inner window supplies the full virtual height.
 */
export function VirtualList<T>({
  items,
  renderItem,
  getItemKey,
  estimateSize,
  overscan = 6,
  className,
  windowClassName,
  itemClassName,
  emptyState = null,
  followBottom = false,
  followThreshold,
  role = "list",
  itemRole = "listitem",
  tabIndex = 0,
  style,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-busy": ariaBusy
}: VirtualListProps<T>) {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const followOptions = useMemo(
    () => getVirtualListFollowOptions(followBottom, followThreshold),
    [followBottom, followThreshold]
  );
  const itemKey = useCallback(
    (index: number) => getItemKey(items[index]!, index),
    [getItemKey, items]
  );

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scrollElementRef.current,
    getItemKey: itemKey,
    estimateSize,
    overscan,
    anchorTo: followOptions.anchorTo,
    followOnAppend: followOptions.followOnAppend,
    initialOffset: followOptions.initialOffset,
    scrollEndThreshold: followOptions.scrollEndThreshold
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollElementRef}
      className={className}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-busy={ariaBusy}
      style={{
        overflow: "auto",
        position: "relative",
        ...style
      }}
    >
      {items.length === 0 ? (
        <div role="status" aria-live="polite">
          {emptyState}
        </div>
      ) : (
        <div
          className={windowClassName}
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%"
          }}
        >
          {virtualItems.map((virtualItem) => {
            const index = virtualItem.index;

            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={index}
                className={itemClassName}
                role={itemRole}
                aria-posinset={index + 1}
                aria-setsize={items.length}
                style={{
                  left: 0,
                  position: "absolute",
                  top: 0,
                  transform: `translate3d(0, ${virtualItem.start}px, 0)`,
                  width: "100%"
                }}
              >
                {renderItem(items[index]!, index)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
