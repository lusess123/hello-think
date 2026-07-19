import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useThreadMessageIds,
  useAuiState
} from "@assistant-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CopyIcon,
  FilePdfIcon,
  FileTextIcon,
  GearIcon,
  ImageIcon,
  MicrophoneIcon,
  PaperPlaneRightIcon,
  PaperclipIcon,
  SpeakerHighIcon,
  StopIcon,
  TrashIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import type { UIMessage } from "ai";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode
} from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { Badge, Button, Empty, Surface, Text } from "@cloudflare/kumo";
import { apiFetch, apiUrl } from "../api-client";
import { VirtualList } from "../components/virtual-list";
import type { DocumentAttachmentData } from "./document-attachment-adapter";

export type BranchInfo = {
  userMessageId: string;
  versions: UIMessage[];
  selectedIndex: number;
};

type AgentCaller = {
  call: (method: string, args?: unknown[]) => Promise<unknown>;
};

type ThreadRenderContextValue = {
  agent: AgentCaller;
  branchByAssistantId: ReadonlyMap<string, BranchInfo>;
  documentRevision: number;
  isStreaming: boolean;
  onSelectBranch: (userMessageId: string, index: number) => void;
  onResolveExecution: (
    executionId: string,
    action: "approve" | "reject"
  ) => Promise<void>;
  resolvingExecutions: ReadonlySet<string>;
};

const ThreadRenderContext = createContext<ThreadRenderContextValue | null>(
  null
);

function useThreadRenderContext() {
  const value = useContext(ThreadRenderContext);
  if (!value) throw new Error("Assistant thread render context is missing");
  return value;
}

export function ThreadRenderProvider({
  value,
  children
}: PropsWithChildren<{ value: ThreadRenderContextValue }>) {
  return (
    <ThreadRenderContext.Provider value={value}>
      {children}
    </ThreadRenderContext.Provider>
  );
}

export function selectVisibleBranchMessages(
  messages: UIMessage[],
  branches: ReadonlyMap<
    string,
    { versions: UIMessage[]; selectedIndex: number }
  >
): {
  messages: UIMessage[];
  branchByAssistantId: Map<string, BranchInfo>;
} {
  const visible = [...messages];
  const branchByAssistantId = new Map<string, BranchInfo>();

  for (let index = 1; index < visible.length; index++) {
    const current = visible[index]!;
    const parent = visible[index - 1]!;
    if (current.role !== "assistant" || parent.role !== "user") continue;
    const branch = branches.get(parent.id);
    if (!branch || branch.versions.length === 0) continue;
    const selectedIndex = Math.min(
      Math.max(0, branch.selectedIndex),
      branch.versions.length - 1
    );
    const selected = branch.versions[selectedIndex] ?? current;
    visible[index] = selected;
    const info = {
      userMessageId: parent.id,
      versions: branch.versions,
      selectedIndex
    };
    branchByAssistantId.set(selected.id, info);
    branchByAssistantId.set(current.id, info);
  }

  return { messages: visible, branchByAssistantId };
}

function EmptyThread() {
  return (
    <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
      <Surface className="p-4 rounded-xl ring ring-kumo-line">
        <Text size="sm" bold>
          Think × assistant-ui
        </Text>
        <span className="mt-1 block">
          <Text size="xs" variant="secondary">
            支持流式聊天、工具审批、回复版本、拖放/粘贴图片和 PDF、大文档检索、
            MCP、Workspace 与扩展。大文件只把检索命中的片段送进模型上下文。
          </Text>
        </span>
      </Surface>
      <Empty
        icon={<FileTextIcon size={32} />}
        title="开始对话"
        description="可以直接提问，也可以拖入 PDF、文本或图片"
      />
    </div>
  );
}

const MESSAGE_COMPONENTS = {
  UserMessage: UserMessage,
  AssistantMessage: AssistantMessage
};

export function VirtualizedAssistantThread() {
  const messageIds = unstable_useThreadMessageIds();
  const showPendingAssistant = useAuiState(
    (state) =>
      state.thread.isRunning &&
      state.thread.messages.at(-1)?.role === "user"
  );
  const itemCount = messageIds.length + Number(showPendingAssistant);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: itemCount,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => messageIds[index] ?? "pending-assistant",
    estimateSize: (index) =>
      index === messageIds.length ? 56 : index % 2 === 0 ? 92 : 180,
    overscan: 6,
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold: 72
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    shouldFollowRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 72;
  }, []);

  useEffect(() => {
    if (!shouldFollowRef.current || itemCount === 0) return;
    virtualizer.scrollToIndex(itemCount - 1, { align: "end" });
  }, [itemCount, totalSize, virtualizer]);

  if (itemCount === 0) return <EmptyThread />;

  return (
    <ThreadPrimitive.Root className="h-full min-h-0 relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain"
        role="log"
        aria-label="聊天消息"
        aria-live="polite"
      >
        <div
          className="max-w-3xl mx-auto px-5 py-6"
          style={{ height: totalSize, position: "relative" }}
        >
          {virtualItems.map((virtualItem) => (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              className="pb-5"
              style={{
                left: 20,
                position: "absolute",
                right: 20,
                top: 0,
                transform: `translate3d(0, ${virtualItem.start}px, 0)`
              }}
            >
              {virtualItem.index === messageIds.length ? (
                <AssistantThinkingMessage />
              ) : (
                <ThreadPrimitive.Unstable_MessageById
                  messageId={messageIds[virtualItem.index]!}
                  components={MESSAGE_COMPONENTS}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="absolute bottom-4 right-5 rounded-full border border-kumo-line bg-kumo-base p-2 text-kumo-subtle shadow-md hover:text-kumo-default"
        aria-label="滚动到底部"
        onClick={() => {
          shouldFollowRef.current = true;
          virtualizer.scrollToIndex(itemCount - 1, {
            align: "end",
            behavior: "smooth"
          });
        }}
      >
        <ArrowDownIcon size={16} />
      </button>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[88%] space-y-2 rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-kumo-inverse leading-relaxed">
        <MessagePrimitive.Parts
          components={{
            Text: UserTextPart,
            data: { by_name: { document: DocumentDataPart } },
            Image: ImagePart,
            File: FilePart
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function UserTextPart({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap">{text}</div>;
}

function AssistantMessage() {
  const { isStreaming, onSelectBranch, branchByAssistantId } =
    useThreadRenderContext();
  // Select primitives separately. Returning a new object here on every
  // `getSnapshot()` call makes React 19 treat the external store as changing
  // forever and eventually throw "Maximum update depth exceeded".
  const messageId = useAuiState((state) => state.message.id);
  const isLast = useAuiState((state) => state.message.isLast);
  const showThinking = useAuiState(
    (state) =>
      state.message.status?.type === "running" &&
      !state.message.content.some((part) => {
        if (part.type === "text" || part.type === "reasoning") {
          return part.text.length > 0;
        }
        return true;
      })
  );
  const branch = branchByAssistantId.get(messageId);

  return (
    <MessagePrimitive.Root className="group/message space-y-2">
      {showThinking ? <AssistantThinkingBubble /> : null}
      <MessagePrimitive.Parts
        components={{
          Text: AssistantTextPart,
          Reasoning: ReasoningPart,
          Source: SourcePart,
          Image: ImagePart,
          File: FilePart,
          data: { by_name: { document: DocumentDataPart } },
          tools: { Fallback: ToolPart }
        }}
      />
      <div className="flex items-center gap-1 min-h-7 text-kumo-subtle opacity-0 group-hover/message:opacity-100 focus-within:opacity-100 transition-opacity">
        <ActionBarPrimitive.Root className="flex items-center gap-1">
          <ActionBarPrimitive.Copy
            className="aui-action-button"
            aria-label="复制消息"
          >
            <CopyIcon size={14} />
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Speak
            className="aui-action-button"
            aria-label="朗读消息"
          >
            <SpeakerHighIcon size={14} />
          </ActionBarPrimitive.Speak>
          {isLast && !isStreaming && (
            <ActionBarPrimitive.Reload
              className="aui-action-button"
              aria-label="重新生成"
            >
              <ArrowsClockwiseIcon size={14} />
            </ActionBarPrimitive.Reload>
          )}
        </ActionBarPrimitive.Root>
        {branch && branch.versions.length > 1 && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="aui-action-button"
              aria-label="上一版本"
              disabled={branch.selectedIndex === 0}
              onClick={() =>
                onSelectBranch(branch.userMessageId, branch.selectedIndex - 1)
              }
            >
              <CaretLeftIcon size={13} />
            </button>
            <span className="text-xs tabular-nums px-1">
              {branch.selectedIndex + 1}/{branch.versions.length}
            </span>
            <button
              type="button"
              className="aui-action-button"
              aria-label="下一版本"
              disabled={branch.selectedIndex === branch.versions.length - 1}
              onClick={() =>
                onSelectBranch(branch.userMessageId, branch.selectedIndex + 1)
              }
            >
              <CaretRightIcon size={13} />
            </button>
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantTextPart({
  text,
  status
}: {
  text: string;
  status: { type: string };
}) {
  const isRunning = status.type === "running";
  if (!text) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 text-kumo-default leading-relaxed">
        <Streamdown
          className="aui-streaming-content sd-theme min-h-[1.25em]"
          plugins={{ code }}
          controls={false}
          isAnimating={isRunning}
          caret="block"
        >
          {text}
        </Streamdown>
      </div>
    </div>
  );
}

function AssistantThinkingMessage() {
  return (
    <div role="listitem">
      <AssistantThinkingBubble />
    </div>
  );
}

function AssistantThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 text-kumo-default leading-relaxed">
        <ThinkingIndicator />
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex min-h-5 items-center gap-2 text-sm text-kumo-subtle">
      <span className="aui-thinking-dot" aria-hidden="true" />
      <span>正在思考</span>
    </div>
  );
}

function ReasoningPart({ text }: { text: string }) {
  return (
    <details className="max-w-[92%] rounded-xl border border-kumo-line bg-kumo-base/60 px-3 py-2 text-xs text-kumo-subtle">
      <summary className="cursor-pointer flex items-center gap-2 font-medium">
        <GearIcon size={13} /> 推理过程
      </summary>
      <div className="mt-2 whitespace-pre-wrap italic">{text || "…"}</div>
    </details>
  );
}

function SourcePart({
  sourceType,
  url,
  title
}: {
  sourceType: "url" | "document";
  url?: string;
  title?: string;
}) {
  const label = title || (sourceType === "url" ? url : "文档来源");
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-[92%] items-center gap-1 rounded-md border border-kumo-line px-2 py-1 text-xs text-kumo-brand hover:underline"
    >
      <FileTextIcon size={12} /> {label}
    </a>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-kumo-subtle">
      <FileTextIcon size={12} /> {label}
    </span>
  );
}

function ImagePart({ image, filename }: { image: string; filename?: string }) {
  return (
    <a href={image} target="_blank" rel="noreferrer" className="block">
      <img
        src={image}
        alt={filename ?? "上传图片"}
        loading="lazy"
        className="max-h-80 max-w-full rounded-lg object-contain"
      />
    </a>
  );
}

function FilePart({
  filename,
  data,
  mimeType
}: {
  filename?: string;
  data: string;
  mimeType: string;
}) {
  return (
    <a
      href={data}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-kumo-line px-3 py-2 text-xs hover:bg-kumo-fill-hover"
    >
      {mimeType === "application/pdf" ? (
        <FilePdfIcon size={18} />
      ) : (
        <FileTextIcon size={18} />
      )}
      {filename ?? "附件"}
    </a>
  );
}

function DocumentDataPart({ data }: { data: DocumentAttachmentData }) {
  const { documentRevision } = useThreadRenderContext();
  const [status, setStatus] = useState(data.status);
  useEffect(() => {
    let active = true;
    void apiFetch(`/chat/documents/${encodeURIComponent(data.documentId)}`)
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as {
          document?: { status?: DocumentAttachmentData["status"] };
        };
        if (active && body.document?.status) setStatus(body.document.status);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [data.documentId, documentRevision]);

  const Icon =
    data.kind === "image"
      ? ImageIcon
      : data.kind === "pdf"
        ? FilePdfIcon
        : FileTextIcon;
  return (
    <a
      href={apiUrl(data.contentUrl)}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-lg border border-white/20 bg-black/10 px-3 py-2 text-xs"
    >
      <Icon size={19} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{data.name}</span>
        <span className="opacity-70">
          {formatBytes(data.sizeBytes)} · {documentStatusLabel(status)}
        </span>
      </span>
    </a>
  );
}

type ToolPartProps = {
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  status: { type: string };
  approval?: { id: string; approved?: boolean; resolution?: string };
  respondToApproval: (response: { approved: boolean }) => void;
};

function ToolPart(props: ToolPartProps) {
  const {
    agent,
    resolvingExecutions,
    onResolveExecution
  } = useThreadRenderContext();
  const paused = asPausedExecution(props.result);
  if (paused) {
    return (
      <PausedExecutionCard
        agent={agent}
        executionId={paused.executionId}
        toolName={props.toolName}
        preview={paused.pending}
        resolving={resolvingExecutions.has(paused.executionId)}
        onResolve={onResolveExecution}
      />
    );
  }

  const approvalPending =
    props.approval &&
    props.approval.approved === undefined &&
    !props.approval.resolution;
  const searchHits = getSearchHits(props.toolName, props.result);
  const running = props.status.type === "running" && props.result === undefined;

  return (
    <Surface
      className={`max-w-[92%] rounded-xl p-3 ring ${
        approvalPending ? "ring-2 ring-kumo-warning" : "ring-kumo-line"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <GearIcon
          size={14}
          className={running ? "animate-spin text-kumo-brand" : "text-kumo-subtle"}
        />
        <Text size="xs" bold>
          {props.toolName}
        </Text>
        <Badge variant={props.isError ? "error" : "secondary"}>
          {approvalPending
            ? "待审批"
            : running
              ? "运行中"
              : props.isError
                ? "失败"
                : "完成"}
        </Badge>
      </div>
      {props.args != null && (
        <JsonDetails label="输入" value={props.args} defaultOpen={approvalPending} />
      )}
      {searchHits ? (
        <VirtualList
          items={searchHits}
          getItemKey={(hit) => hit.citation.id}
          estimateSize={() => 112}
          overscan={3}
          aria-label="文档检索结果"
          className="mt-2 max-h-72 rounded-lg border border-kumo-line"
          itemClassName="p-2"
          renderItem={(hit) => (
            <div className="rounded-md bg-kumo-elevated p-2 text-xs">
              <div className="font-medium text-kumo-default">
                {hit.citation.label}
              </div>
              <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-kumo-subtle">
                {hit.content}
              </div>
            </div>
          )}
        />
      ) : (
        props.result !== undefined && (
          <JsonDetails label="输出" value={props.result} defaultOpen={props.isError} />
        )
      )}
      {approvalPending && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="primary"
            icon={<CheckCircleIcon size={14} />}
            onClick={() => props.respondToApproval({ approved: true })}
          >
            允许
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<XCircleIcon size={14} />}
            onClick={() => props.respondToApproval({ approved: false })}
          >
            拒绝
          </Button>
        </div>
      )}
    </Surface>
  );
}

function JsonDetails({
  label,
  value,
  defaultOpen = false
}: {
  label: string;
  value: unknown;
  defaultOpen?: boolean;
}) {
  return (
    <details className="font-mono text-xs" open={defaultOpen || undefined}>
      <summary className="cursor-pointer text-kumo-subtle">{label}</summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-kumo-subtle">
        {safeJson(value)}
      </pre>
    </details>
  );
}

type PendingActionPreview = {
  id: string;
  description?: string;
  input?: unknown;
};

function PausedExecutionCard({
  agent,
  executionId,
  toolName,
  preview,
  resolving,
  onResolve
}: {
  agent: AgentCaller;
  executionId: string;
  toolName: string;
  preview?: PendingActionPreview[];
  resolving: boolean;
  onResolve: (
    executionId: string,
    action: "approve" | "reject"
  ) => Promise<void>;
}) {
  const [actions, setActions] = useState<PendingActionPreview[]>(preview ?? []);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void agent
      .call("pendingExecutions", [executionId])
      .then((value) => {
        if (!active) return;
        const next = Array.isArray(value)
          ? (value as PendingActionPreview[])
          : [];
        setActions(next.length > 0 ? next : preview ?? []);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [agent, executionId, preview]);

  return (
    <Surface className="max-w-[92%] rounded-xl p-3 ring-2 ring-kumo-warning">
      <div className="flex items-center gap-2">
        <GearIcon size={15} className="text-kumo-warning" />
        <Text size="sm" bold>
          执行暂停：{toolName}
        </Text>
      </div>
      <VirtualList
        items={actions}
        getItemKey={(action) => action.id}
        estimateSize={() => 72}
        overscan={2}
        aria-label="待审批动作"
        className="mt-2 max-h-48 rounded-lg border border-kumo-line"
        itemClassName="p-2"
        emptyState={
          <div className="p-3 text-xs text-kumo-subtle">
            {loading ? "正在读取待审批动作…" : "没有可审批动作"}
          </div>
        }
        renderItem={(action) => (
          <div className="text-xs">
            <div className="font-medium">{action.description ?? action.id}</div>
            {action.input !== undefined && (
              <pre className="mt-1 whitespace-pre-wrap text-kumo-subtle">
                {safeJson(action.input)}
              </pre>
            )}
          </div>
        )}
      />
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={loading || resolving || actions.length === 0}
          icon={<CheckCircleIcon size={14} />}
          onClick={() => void onResolve(executionId, "approve")}
        >
          批准并继续
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={resolving}
          icon={<XCircleIcon size={14} />}
          onClick={() => void onResolve(executionId, "reject")}
        >
          拒绝
        </Button>
      </div>
    </Surface>
  );
}

function ComposerAttachment() {
  const attachment = useAuiState((state) => state.attachment);
  const progress =
    attachment.status.type === "running" ? attachment.status.progress : null;
  const failed = attachment.status.type === "incomplete";
  const failureMessage =
    attachment.status.type === "incomplete"
      ? attachment.status.message
      : undefined;
  return (
    <AttachmentPrimitive.Root className="flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-elevated px-2 py-1.5 text-xs">
      <AttachmentPrimitive.unstable_Thumb className="grid size-8 place-items-center rounded bg-kumo-base text-[10px] uppercase text-kumo-subtle" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">
          <AttachmentPrimitive.Name />
        </div>
        <div className={failed ? "text-kumo-danger" : "text-kumo-subtle"}>
          {progress !== null
            ? `上传中 ${Math.round(progress * 100)}%`
            : failed
              ? failureMessage ?? "上传失败"
              : "已上传，正在建立索引"}
        </div>
        {progress !== null && (
          <div className="mt-1 h-1 overflow-hidden rounded bg-kumo-line">
            <div
              className="h-full bg-kumo-brand transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </div>
      <AttachmentPrimitive.Remove
        className="aui-action-button"
        aria-label="移除附件"
      >
        <XIcon size={13} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

const ATTACHMENT_COMPONENTS = { Attachment: ComposerAttachment };

function VirtualizedComposerAttachments() {
  const attachments = useAuiState((state) => state.composer.attachments);
  if (attachments.length === 0) return null;
  return (
    <VirtualList
      items={attachments}
      getItemKey={(attachment) => attachment.id}
      estimateSize={() => 52}
      overscan={2}
      aria-label="待发送附件"
      className="max-h-32"
      itemClassName="pb-1.5"
      renderItem={(_, index) => (
        <ComposerPrimitive.AttachmentByIndex
          index={index}
          components={ATTACHMENT_COMPONENTS}
        />
      )}
    />
  );
}

export function AssistantComposer({
  disabled,
  error
}: {
  disabled: boolean;
  error?: Error;
}) {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const dictating = useAuiState(
    (state) => state.composer.dictation?.status.type === "running"
  );
  return (
    <div className="border-t border-kumo-line bg-kumo-base">
      {error && (
        <div className="max-w-3xl mx-auto px-5 pt-3" role="alert">
          <Surface className="rounded-lg px-3 py-2 ring ring-kumo-danger/50">
            <Text size="xs" variant="error">
              {error.message}
            </Text>
          </Surface>
        </div>
      )}
      <div className="max-w-3xl mx-auto px-5 py-4">
        <ComposerPrimitive.AttachmentDropzone disabled={disabled}>
          <ComposerPrimitive.Root className="rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring data-[dragging=true]:ring-2 data-[dragging=true]:ring-kumo-focus">
            <VirtualizedComposerAttachments />
            <ComposerPrimitive.Input
              rows={2}
              disabled={disabled}
              placeholder="输入问题，或拖放/粘贴图片、PDF、文本…"
              className="max-h-48 min-h-12 w-full resize-none bg-transparent text-sm text-kumo-default outline-none placeholder:text-kumo-subtle"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <ComposerPrimitive.AddAttachment
                  className="aui-composer-button"
                  aria-label="添加图片或文档"
                >
                  <PaperclipIcon size={17} />
                  <span>附件</span>
                </ComposerPrimitive.AddAttachment>
                {dictating ? (
                  <ComposerPrimitive.StopDictation
                    className="aui-composer-button text-kumo-danger"
                    aria-label="停止语音输入"
                  >
                    <StopIcon size={15} />
                    <span>停止听写</span>
                  </ComposerPrimitive.StopDictation>
                ) : (
                  <ComposerPrimitive.Dictate
                    className="aui-composer-button"
                    aria-label="语音输入"
                  >
                    <MicrophoneIcon size={16} />
                    <span>语音</span>
                  </ComposerPrimitive.Dictate>
                )}
              </div>
              {isRunning ? (
                <ComposerPrimitive.Cancel
                  className="aui-send-button"
                  aria-label="停止生成"
                >
                  <StopIcon size={17} weight="fill" />
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send
                  className="aui-send-button"
                  aria-label="发送消息"
                >
                  <PaperPlaneRightIcon size={18} />
                </ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.Root>
        </ComposerPrimitive.AttachmentDropzone>
      </div>
    </div>
  );
}

function asPausedExecution(output: unknown): {
  executionId: string;
  pending?: PendingActionPreview[];
} | null {
  if (!output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  const executionId = value.executionId;
  if (typeof executionId !== "string" || !executionId) return null;
  const state = value.state ?? value.status;
  if (state !== "paused" && value.pendingApproval !== true) return null;
  return {
    executionId,
    pending: Array.isArray(value.pending)
      ? (value.pending as PendingActionPreview[])
      : undefined
  };
}

type SearchHit = {
  content: string;
  citation: { id: string; label: string };
};

function getSearchHits(toolName: string, result: unknown): SearchHit[] | null {
  if (toolName !== "search_documents" || !result || typeof result !== "object") {
    return null;
  }
  const hits = (result as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return null;
  return hits.filter((hit): hit is SearchHit => {
    if (!hit || typeof hit !== "object") return false;
    const candidate = hit as SearchHit;
    return (
      typeof candidate.content === "string" &&
      typeof candidate.citation?.id === "string" &&
      typeof candidate.citation?.label === "string"
    );
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatBytes(value: number | null): string {
  if (value === null) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function documentStatusLabel(status: DocumentAttachmentData["status"]): string {
  switch (status) {
    case "pending":
      return "等待解析";
    case "processing":
      return "建立索引中";
    case "ready":
      return "可检索";
    case "failed":
      return "索引失败";
  }
}

export const MemoizedVirtualizedAssistantThread = memo(
  VirtualizedAssistantThread
);
