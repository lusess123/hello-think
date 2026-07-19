/**
 * Assistant — Client
 *
 * Chat UI for a Think agent showcasing all Project Think features.
 * Uses useAgentChat from @cloudflare/think/react, the Think-tuned
 * wrapper around the shared CF_AGENT chat protocol client.
 *
 * Features:
 *   - Chat with streaming responses
 *   - Server-side tools (weather, calculate, workspace, code execution)
 *   - Client-side tools (getUserTimezone via onToolCall)
 *   - Tool approval (calculate with large numbers)
 *   - Regeneration with branch navigation (v1/v2/v3)
 *   - MCP server management
 *   - Workspace file browser
 *   - Extension management
 *   - Dynamic configuration (model tier, persona)
 *   - Dark mode toggle
 */

import "./styles.css";
import { createRoot } from "react-dom/client";
import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo,
  type ReactNode
} from "react";
import {
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter
} from "@assistant-ui/react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import type { MCPServersState } from "agents";
import {
  Banner,
  Button,
  Badge,
  Empty,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  TrashIcon,
  CheckCircleIcon,
  GithubLogoIcon,
  RobotIcon,
  PlugsConnectedIcon,
  PlusIcon,
  ShieldCheckIcon,
  SignInIcon,
  SignOutIcon,
  XIcon,
  WrenchIcon,
  MoonIcon,
  SunIcon,
  InfoIcon,
  CopyIcon,
  CaretLeftIcon,
  FolderOpenIcon,
  PuzzlePieceIcon,
  SlidersHorizontalIcon,
  FileTextIcon,
  ListIcon,
  PencilIcon,
  ChatsIcon,
  GitBranchIcon
} from "@phosphor-icons/react";
import {
  fetchCurrentUser,
  signOut,
  startGitHubLogin,
  type AuthUser
} from "./auth-client";
import { useChats } from "./use-chats";
import type { ChatSummary } from "../agents/assistant/types";
import { ThinkRuntimeProvider } from "./chat/think-runtime";
import { DocumentAttachmentAdapter } from "./chat/document-attachment-adapter";
import { DocumentPanel } from "./chat/document-panel";
import { VirtualList } from "./components/virtual-list";
import {
  ProductConfirmDialog,
  ProductPromptDialog
} from "./components/product-dialog";
import { normalizedRename } from "./components/product-dialog-model";
import { StoryPanel } from "./story";
import {
  AssistantComposer,
  MemoizedVirtualizedAssistantThread,
  ThreadRenderProvider,
  selectVisibleBranchMessages
} from "./chat/assistant-thread";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </output>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

function formatJsonBlock(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return `\`\`\`json\n${text}\n\`\`\``;
}

/**
 * Serialize the visible chat into plain markdown so a transcript can be
 * pasted anywhere (issues, chats, docs) with user/assistant/tool turns and
 * reasoning clearly annotated.
 */
function formatTranscript(messages: UIMessage[], chatTitle: string): string {
  const lines: string[] = [`# ${chatTitle}`, ""];

  for (const message of messages) {
    if (message.role === "user") {
      lines.push("## User", "", getMessageText(message), "");
      continue;
    }

    if (message.role !== "assistant") continue;
    lines.push("## Assistant", "");

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text.trim()) lines.push(part.text.trim(), "");
        continue;
      }

      if (part.type === "reasoning") {
        if (!part.text.trim()) continue;
        lines.push(
          "<details><summary>Reasoning</summary>",
          "",
          part.text.trim(),
          "",
          "</details>",
          ""
        );
        continue;
      }

      if (isToolUIPart(part)) {
        const toolName = getToolName(part);
        lines.push(`### Tool: \`${toolName}\``, "");
        if (part.input != null) {
          lines.push("**Input**", "", formatJsonBlock(part.input), "");
        }
        if (part.state === "output-available") {
          lines.push("**Output**", "", formatJsonBlock(part.output), "");
        } else if (part.state === "output-error") {
          lines.push("**Error**", "", "```", part.errorText ?? "", "```", "");
        } else if (part.state === "approval-requested") {
          lines.push("_Waiting for approval._", "");
        } else {
          lines.push(`_State: ${part.state}_`, "");
        }
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function CopyTranscriptButton({
  messages,
  chatTitle
}: {
  messages: UIMessage[];
  chatTitle: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(formatTranscript(messages, chatTitle));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [messages, chatTitle]);

  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      aria-label="Copy transcript as markdown"
      icon={copied ? <CheckCircleIcon size={12} /> : <CopyIcon size={12} />}
      disabled={messages.length === 0}
      onClick={copy}
    />
  );
}

function Chat({
  chatId,
  chatTitle,
  workspaceRevision,
  sharedDocumentRevision,
  mcpState,
  addMcpServer,
  removeMcpServer,
  onOpenSidebar,
  storyPanelOpen,
  onToggleStoryPanel,
  onRequestRename,
  onRequestDelete
}: {
  chatId: string;
  chatTitle: string;
  /**
   * Bumps whenever another chat (or this chat) mutates the shared
   * workspace. Used as a `useEffect` dep so the files panel stays
   * live across chats and open tabs without polling.
   */
  workspaceRevision: number;
  /** Shared document changes broadcast by the user directory. */
  sharedDocumentRevision: number;
  /**
   * Live MCP state for the whole user. Sourced from the directory's
   * `CF_AGENT_MCP_SERVERS` broadcasts; the same server list shows up
   * in every chat pane.
   */
  mcpState: MCPServersState;
  /**
   * Register a new MCP server on the directory. The returned
   * `authUrl`, if any, should be opened in a popup for the user to
   * complete OAuth.
   */
  addMcpServer: (
    name: string,
    url: string
  ) => Promise<{ id: string; state: string; authUrl?: string }>;
  /** Remove an MCP server from the shared registry. */
  removeMcpServer: (id: string) => Promise<void>;
  onOpenSidebar: () => void;
  storyPanelOpen: boolean;
  onToggleStoryPanel: () => void;
  onRequestRename: () => void;
  onRequestDelete: () => void;
}) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingServer, setIsAddingServer] = useState(false);
  const mcpPanelRef = useRef<HTMLDivElement>(null);

  const [showFilesPanel, setShowFilesPanel] = useState(false);
  const filesPanelRef = useRef<HTMLDivElement>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<
    { name: string; type: string; size?: number }[]
  >([]);
  const [fileContent, setFileContent] = useState<{
    path: string;
    content: string;
  } | null>(null);

  const [showExtensionsPanel, setShowExtensionsPanel] = useState(false);
  const extensionsPanelRef = useRef<HTMLDivElement>(null);
  const [extensions, setExtensions] = useState<
    { name: string; tools: string[] }[]
  >([]);

  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const [agentConfig, setAgentConfig] = useState<{
    modelTier: "fast" | "capable";
    persona: string;
  } | null>(null);

  const [showDocumentsPanel, setShowDocumentsPanel] = useState(false);
  const documentsPanelRef = useRef<HTMLDivElement>(null);

  // Execution ids with an approve/reject in flight — disables the card's
  // buttons until the runtime answers (the updated tool output then arrives
  // over the socket and re-renders the card away).
  const [resolvingExecutions, setResolvingExecutions] = useState<Set<string>>(
    () => new Set()
  );

  const agent = useAgent({
    // This chat lives as a facet of the user's AssistantDirectory. The
    // `sub` option builds the nested URL tail `/sub/my-assistant/:chatId`.
    // The parent's `onBeforeSubAgent` strict-registry gate runs once on
    // connect; after the WebSocket upgrade, frames flow straight to the
    // child `MyAssistant` DO.
    //
    // MCP state (servers, tools, auth) is not received on this socket
    // any more — MCP lives on the directory now, so `useChats()` owns
    // the MCP broadcasts and we receive the resulting state as a prop.
    agent: "AssistantDirectory",
    basePath: "chat",
    sub: [{ agent: "MyAssistant", name: chatId }],
    onOpen: useCallback(() => {
      setConnectionStatus("connected");
    }, []),
    onClose: useCallback(() => {
      setConnectionStatus("disconnected");
    }, []),
    onError: useCallback((error: Event) => {
      console.error("WebSocket error:", error);
    }, [])
  });

  useEffect(() => {
    if (!showMcpPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        mcpPanelRef.current &&
        !mcpPanelRef.current.contains(e.target as Node)
      ) {
        setShowMcpPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMcpPanel]);

  useEffect(() => {
    if (!showFilesPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        filesPanelRef.current &&
        !filesPanelRef.current.contains(e.target as Node)
      ) {
        setShowFilesPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showFilesPanel]);

  useEffect(() => {
    if (!showExtensionsPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        extensionsPanelRef.current &&
        !extensionsPanelRef.current.contains(e.target as Node)
      ) {
        setShowExtensionsPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showExtensionsPanel]);

  useEffect(() => {
    if (!showConfigPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        configPanelRef.current &&
        !configPanelRef.current.contains(e.target as Node)
      ) {
        setShowConfigPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showConfigPanel]);

  useEffect(() => {
    if (!showDocumentsPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        documentsPanelRef.current &&
        !documentsPanelRef.current.contains(e.target as Node)
      ) {
        setShowDocumentsPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDocumentsPanel]);

  const resolveExecution = useCallback(
    async (executionId: string, action: "approve" | "reject") => {
      setResolvingExecutions((prev) => new Set(prev).add(executionId));
      try {
        // The callable replaces the paused tool output in the transcript and
        // auto-continues the chat; the updated message arrives over the
        // socket. A stale card (expired / approved elsewhere) resolves to a
        // graceful error output the same way.
        await agent.call(
          action === "approve" ? "approveExecution" : "rejectExecution",
          [executionId]
        );
      } catch (error) {
        console.error(`Failed to ${action} execution:`, error);
      } finally {
        setResolvingExecutions((prev) => {
          const next = new Set(prev);
          next.delete(executionId);
          return next;
        });
      }
    },
    [agent]
  );

  const refreshWorkspaceFiles = useCallback(async () => {
    try {
      const files = await agent.call("listWorkspaceFiles", ["/"]);
      setWorkspaceFiles(
        files as { name: string; type: string; size?: number }[]
      );
    } catch {
      setWorkspaceFiles([]);
    }
  }, [agent]);

  // Live-refresh the file browser when the shared workspace changes in
  // another chat (or this one). `workspaceRevision` is incremented by
  // `useChats()` each time the directory broadcasts a change event. We
  // only refetch if the panel is actually open — no point fetching just
  // to throw the result away, and `workspaceFiles` is still seeded on
  // panel-open via the existing click handler.
  useEffect(() => {
    if (!showFilesPanel) return;
    void refreshWorkspaceFiles();
  }, [showFilesPanel, workspaceRevision, refreshWorkspaceFiles]);

  const refreshExtensions = useCallback(async () => {
    try {
      const exts = await agent.call("listExtensions", []);
      setExtensions(exts as { name: string; tools: string[] }[]);
    } catch {
      setExtensions([]);
    }
  }, [agent]);

  const refreshConfig = useCallback(async () => {
    try {
      const config = await agent.call("currentConfig", []);
      setAgentConfig(
        config as { modelTier: "fast" | "capable"; persona: string } | null
      );
    } catch {
      setAgentConfig(null);
    }
  }, [agent]);

  const handleAddServer = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingServer(true);
    try {
      const result = await addMcpServer(mcpName.trim(), mcpUrl.trim());
      setMcpName("");
      setMcpUrl("");
      // If the server needs OAuth, pop the auth URL open. Callback
      // lands at /chat/mcp-callback on the directory; our client-side
      // state refreshes via the directory's MCP broadcast.
      if (result.authUrl) {
        window.open(result.authUrl, "oauth", "width=600,height=800");
      }
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    } finally {
      setIsAddingServer(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await removeMcpServer(serverId);
    } catch (e) {
      console.error("Failed to remove MCP server:", e);
    }
  };

  const serverEntries = Object.entries(mcpState.servers);
  const mcpToolCount = mcpState.tools.length;

  const thinkChat = useAgentChat({
    agent,
    experimental_throttle: 40,
    getInitialMessages: null,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "getUserTimezone") {
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });
  const {
    messages,
    regenerate,
    clearHistory,
    isStreaming,
    error,
    clearError
  } = thinkChat;

  const isConnected = connectionStatus === "connected";
  const [localDocumentRevision, setLocalDocumentRevision] = useState(0);
  const attachmentAdapter = useMemo(
    () =>
      new DocumentAttachmentAdapter(() =>
        setLocalDocumentRevision((revision) => revision + 1)
      ),
    []
  );
  const documentRevision = sharedDocumentRevision + localDocumentRevision;
  const speechAdapter = useMemo(() => new WebSpeechSynthesisAdapter(), []);
  const dictationAdapter = useMemo(
    () =>
      WebSpeechDictationAdapter.isSupported()
        ? new WebSpeechDictationAdapter()
        : undefined,
    []
  );

  // ── Branch navigation state ─────────────────────────────────────
  // Maps userMessageId -> { versions: UIMessage[], selectedIndex: number }
  const [branches, setBranches] = useState<
    Map<string, { versions: UIMessage[]; selectedIndex: number }>
  >(new Map());
  const queriedBranchIdsRef = useRef(new Set<string>());

  const fetchBranches = useCallback(
    async (userMessageId: string, force = false) => {
      if (!force && queriedBranchIdsRef.current.has(userMessageId)) return;
      queriedBranchIdsRef.current.add(userMessageId);
      try {
        const versions = (await agent.call("getResponseVersions", [
          userMessageId
        ])) as UIMessage[];
        if (versions.length > 1) {
          setBranches((prev) => {
            const next = new Map(prev);
            const existing = prev.get(userMessageId);
            next.set(userMessageId, {
              versions,
              selectedIndex: existing?.selectedIndex ?? versions.length - 1
            });
            return next;
          });
        }
      } catch {
        // A reconnect or the next completed message will retry transient RPC
        // failures instead of permanently hiding this message's branches.
        queriedBranchIdsRef.current.delete(userMessageId);
      }
    },
    [agent]
  );

  // Hydrate branch metadata once per user message. The Set makes the total RPC
  // count linear across a long conversation; regeneration explicitly forces
  // a refresh for its affected user message.
  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (isStreaming || messages.length === 0) return;
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role === "user" && messages[i + 1].role === "assistant") {
        fetchBranches(messages[i].id);
      }
    }
  }, [lastMessageId, isStreaming, fetchBranches, messages, connectionStatus]);

  // Clear branch state on history clear
  const handleClearHistory = useCallback(() => {
    clearError();
    clearHistory();
    setBranches(new Map());
    queriedBranchIdsRef.current.clear();
  }, [clearError, clearHistory]);

  const handleRegenerate = useCallback(async () => {
    if (isStreaming) return;
    clearError();
    const userMessageId = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.id;
    await regenerate();
    if (userMessageId) await fetchBranches(userMessageId, true);
  }, [isStreaming, regenerate, clearError, messages, fetchBranches]);

  const selectBranch = useCallback((userMessageId: string, index: number) => {
    setBranches((prev) => {
      const next = new Map(prev);
      const entry = prev.get(userMessageId);
      if (entry) {
        next.set(userMessageId, { ...entry, selectedIndex: index });
      }
      return next;
    });
  }, []);

  const visibleBranchState = useMemo(
    () => selectVisibleBranchMessages(messages, branches),
    [messages, branches]
  );
  const runtimeChat = useMemo(
    () => ({
      ...thinkChat,
      messages: visibleBranchState.messages,
      regenerate: handleRegenerate
    }),
    [thinkChat, visibleBranchState.messages, handleRegenerate]
  );
  const threadRenderValue = useMemo(
    () => ({
      agent,
      branchByAssistantId: visibleBranchState.branchByAssistantId,
      documentRevision,
      isStreaming,
      onSelectBranch: selectBranch,
      onResolveExecution: resolveExecution,
      resolvingExecutions
    }),
    [
      agent,
      visibleBranchState.branchByAssistantId,
      documentRevision,
      isStreaming,
      selectBranch,
      resolveExecution,
      resolvingExecutions
    ]
  );
  const workspaceContentLines = useMemo(
    () => fileContent?.content.split("\n") ?? [],
    [fileContent]
  );

  return (
    <div className="flex flex-col h-full bg-kumo-elevated min-w-0">
      <header className="px-3 md:px-5 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              className="md:hidden"
              aria-label="打开聊天列表"
              icon={<ListIcon size={17} />}
              onClick={onOpenSidebar}
            />
            <h2 className="text-base font-semibold text-kumo-default truncate">
              {chatTitle}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Rename chat"
              icon={<PencilIcon size={12} />}
              onClick={onRequestRename}
            />
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Delete chat"
              icon={<TrashIcon size={12} />}
              onClick={onRequestDelete}
            />
            <CopyTranscriptButton messages={messages} chatTitle={chatTitle} />
          </div>
          <div className="flex max-w-full items-center gap-2 overflow-x-auto pb-0.5">
            <ConnectionIndicator status={connectionStatus} />
            <Button
              variant={storyPanelOpen ? "primary" : "secondary"}
              icon={<GitBranchIcon size={16} />}
              aria-pressed={storyPanelOpen}
              onClick={onToggleStoryPanel}
            >
              剧本
            </Button>
            <div className="relative" ref={documentsPanelRef}>
              <Button
                variant="secondary"
                icon={<FileTextIcon size={16} />}
                onClick={() => setShowDocumentsPanel((open) => !open)}
              >
                文档
              </Button>
              {showDocumentsPanel && (
                <div className="fixed left-2 right-2 top-16 z-50 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2">
                  <DocumentPanel
                    revision={documentRevision}
                    onClose={() => setShowDocumentsPanel(false)}
                  />
                </div>
              )}
            </div>
            <div className="relative" ref={mcpPanelRef}>
              <Button
                variant="secondary"
                icon={<PlugsConnectedIcon size={16} />}
                onClick={() => setShowMcpPanel(!showMcpPanel)}
              >
                MCP
                {mcpToolCount > 0 && (
                  <Badge variant="primary" className="ml-1.5">
                    <WrenchIcon size={10} className="mr-0.5" />
                    {mcpToolCount}
                  </Badge>
                )}
              </Button>

              {showMcpPanel && (
                <div className="absolute right-0 top-full mt-2 w-96 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlugsConnectedIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          MCP Servers
                        </Text>
                        {serverEntries.length > 0 && (
                          <Badge variant="secondary">
                            {serverEntries.length}
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close MCP panel"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowMcpPanel(false)}
                      />
                    </div>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleAddServer();
                      }}
                      className="space-y-2"
                    >
                      <input
                        aria-label="Server name"
                        type="text"
                        value={mcpName}
                        onChange={(e) => setMcpName(e.target.value)}
                        placeholder="Server name"
                        className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
                      />
                      <div className="flex gap-2">
                        <input
                          aria-label="https://mcp.example.com"
                          type="text"
                          value={mcpUrl}
                          onChange={(e) => setMcpUrl(e.target.value)}
                          placeholder="https://mcp.example.com"
                          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent font-mono"
                        />
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          icon={<PlusIcon size={14} />}
                          disabled={
                            isAddingServer || !mcpName.trim() || !mcpUrl.trim()
                          }
                        >
                          {isAddingServer ? "..." : "Add"}
                        </Button>
                      </div>
                    </form>

                    {serverEntries.length > 0 && (
                      <VirtualList
                        items={serverEntries}
                        getItemKey={([id]) => id}
                        estimateSize={() => 84}
                        overscan={3}
                        aria-label="MCP 服务器"
                        className="max-h-60"
                        itemClassName="pb-2"
                        renderItem={([id, server]) => (
                          <div className="flex items-start justify-between rounded-lg border border-kumo-line p-2.5">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-kumo-default truncate">
                                  {server.name}
                                </span>
                                <Badge
                                  variant={
                                    server.state === "ready"
                                      ? "primary"
                                      : server.state === "failed"
                                        ? "destructive"
                                        : "secondary"
                                  }
                                >
                                  {server.state}
                                </Badge>
                              </div>
                              <span className="text-xs font-mono text-kumo-subtle truncate block mt-0.5">
                                {server.server_url}
                              </span>
                              {server.state === "failed" && server.error && (
                                <span className="text-xs text-red-500 block mt-0.5">
                                  {server.error}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              {server.state === "authenticating" &&
                                server.auth_url && (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    icon={<SignInIcon size={12} />}
                                    onClick={() =>
                                      window.open(
                                        server.auth_url as string,
                                        "oauth",
                                        "width=600,height=800"
                                      )
                                    }
                                  >
                                    Auth
                                  </Button>
                                )}
                              <Button
                                variant="ghost"
                                size="sm"
                                shape="square"
                                aria-label="Remove server"
                                icon={<TrashIcon size={12} />}
                                onClick={() => handleRemoveServer(id)}
                              />
                            </div>
                          </div>
                        )}
                      />
                    )}

                    {mcpToolCount > 0 && (
                      <div className="pt-2 border-t border-kumo-line">
                        <div className="flex items-center gap-2">
                          <WrenchIcon size={14} className="text-kumo-subtle" />
                          <span className="text-xs text-kumo-subtle">
                            {mcpToolCount} tool
                            {mcpToolCount !== 1 ? "s" : ""} available from MCP
                            servers
                          </span>
                        </div>
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>
            <div className="relative" ref={filesPanelRef}>
              <Button
                variant="secondary"
                shape="square"
                aria-label="Workspace files"
                icon={<FolderOpenIcon size={16} />}
                onClick={() => {
                  setShowFilesPanel(!showFilesPanel);
                  if (!showFilesPanel) refreshWorkspaceFiles();
                }}
              />
              {showFilesPanel && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FolderOpenIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          Workspace
                        </Text>
                        <Badge variant="secondary">
                          {workspaceFiles.length}
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close"
                        icon={<XIcon size={14} />}
                        onClick={() => {
                          setShowFilesPanel(false);
                          setFileContent(null);
                        }}
                      />
                    </div>
                    {fileContent ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setFileContent(null)}
                          >
                            <CaretLeftIcon size={12} /> Back
                          </Button>
                          <span className="text-xs font-mono text-kumo-subtle truncate">
                            {fileContent.path}
                          </span>
                        </div>
                        <VirtualList
                          items={workspaceContentLines}
                          getItemKey={(_, index) => `${fileContent.path}:${index}`}
                          estimateSize={() => 20}
                          overscan={8}
                          aria-label={`${fileContent.path} 文件内容`}
                          className="max-h-60 rounded-lg bg-kumo-elevated py-2 font-mono text-xs"
                          emptyState={
                            <div className="px-3 py-2 text-kumo-subtle">
                              空文件
                            </div>
                          }
                          renderItem={(line, index) => (
                            <div className="grid min-w-max grid-cols-[3rem_1fr] leading-5">
                              <span className="select-none pr-3 text-right text-kumo-inactive">
                                {index + 1}
                              </span>
                              <code className="whitespace-pre pr-3 text-kumo-default">
                                {line || " "}
                              </code>
                            </div>
                          )}
                        />
                      </div>
                    ) : workspaceFiles.length === 0 ? (
                      <span className="text-xs text-kumo-subtle block">
                        No files yet. Ask the assistant to create some.
                      </span>
                    ) : (
                      <VirtualList
                        items={workspaceFiles}
                        getItemKey={(file) => file.name}
                        estimateSize={() => 40}
                        overscan={5}
                        aria-label="Workspace 文件"
                        className="max-h-60"
                        itemClassName="pb-1"
                        renderItem={(f) => (
                          <button
                            className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-kumo-elevated text-left transition-colors"
                            onClick={async () => {
                              if (f.type === "file") {
                                const content = await agent.call(
                                  "readWorkspaceFile",
                                  [`/${f.name}`]
                                );
                                if (content)
                                  setFileContent({
                                    path: `/${f.name}`,
                                    content: content as string
                                  });
                              }
                            }}
                          >
                            <FileTextIcon
                              size={14}
                              className="text-kumo-subtle shrink-0"
                            />
                            <span className="text-sm text-kumo-default truncate">
                              {f.name}
                            </span>
                            {f.size != null && (
                              <span className="text-xs text-kumo-inactive ml-auto">
                                {f.size}b
                              </span>
                            )}
                          </button>
                        )}
                      />
                    )}
                  </Surface>
                </div>
              )}
            </div>
            <div className="relative" ref={extensionsPanelRef}>
              <Button
                variant="secondary"
                shape="square"
                aria-label="Extensions"
                icon={<PuzzlePieceIcon size={16} />}
                onClick={() => {
                  setShowExtensionsPanel(!showExtensionsPanel);
                  if (!showExtensionsPanel) refreshExtensions();
                }}
              />
              {showExtensionsPanel && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PuzzlePieceIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          Extensions
                        </Text>
                        <Badge variant="secondary">{extensions.length}</Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowExtensionsPanel(false)}
                      />
                    </div>
                    {extensions.length === 0 ? (
                      <span className="text-xs text-kumo-subtle block">
                        No extensions loaded. Ask the assistant to create one,
                        e.g. "Create an extension that converts temperatures."
                      </span>
                    ) : (
                      <VirtualList
                        items={extensions}
                        getItemKey={(extension) => extension.name}
                        estimateSize={() => 76}
                        overscan={3}
                        aria-label="扩展列表"
                        className="max-h-60"
                        itemClassName="pb-2"
                        renderItem={(ext) => (
                          <div className="rounded-lg border border-kumo-line p-2.5">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-kumo-default">
                                {ext.name}
                              </span>
                              <Badge variant="primary">
                                {ext.tools.length} tools
                              </Badge>
                            </div>
                            <p className="mt-1.5 line-clamp-2 text-xs text-kumo-subtle">
                              {ext.tools.join(" · ") || "无工具"}
                            </p>
                          </div>
                        )}
                      />
                    )}
                  </Surface>
                </div>
              )}
            </div>
            <div className="relative" ref={configPanelRef}>
              <Button
                variant="secondary"
                shape="square"
                aria-label="Configuration"
                icon={<SlidersHorizontalIcon size={16} />}
                onClick={() => {
                  setShowConfigPanel(!showConfigPanel);
                  if (!showConfigPanel) refreshConfig();
                }}
              />
              {showConfigPanel && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <SlidersHorizontalIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          Configuration
                        </Text>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowConfigPanel(false)}
                      />
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label
                          htmlFor="model-tier"
                          className="text-xs font-medium text-kumo-subtle block mb-1"
                        >
                          Model tier
                        </label>
                        <div className="flex gap-2">
                          {(["fast", "capable"] as const).map((tier) => (
                            <Button
                              key={tier}
                              variant={
                                (agentConfig?.modelTier ?? "fast") === tier
                                  ? "primary"
                                  : "secondary"
                              }
                              size="sm"
                              onClick={async () => {
                                const newConfig = {
                                  modelTier: tier,
                                  persona: agentConfig?.persona ?? ""
                                };
                                await agent.call("updateConfig", [newConfig]);
                                setAgentConfig(newConfig);
                              }}
                            >
                              {tier}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label
                          htmlFor="persona"
                          className="text-xs font-medium text-kumo-subtle block mb-1"
                        >
                          Persona
                        </label>
                        <textarea
                          aria-label="You are a helpful assistant"
                          className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent resize-none"
                          rows={3}
                          placeholder="You are a helpful assistant..."
                          value={agentConfig?.persona ?? ""}
                          onChange={(e) =>
                            setAgentConfig((prev) => ({
                              modelTier: prev?.modelTier ?? "fast",
                              persona: e.target.value
                            }))
                          }
                          onBlur={async () => {
                            if (agentConfig) {
                              await agent.call("updateConfig", [agentConfig]);
                            }
                          }}
                        />
                      </div>
                    </div>
                  </Surface>
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <ThinkRuntimeProvider
        chat={runtimeChat}
        attachmentAdapter={attachmentAdapter}
        dictationAdapter={dictationAdapter}
        speechAdapter={speechAdapter}
        isDisabled={!isConnected}
      >
        <ThreadRenderProvider value={threadRenderValue}>
          <div className="flex-1 min-h-0">
            <MemoizedVirtualizedAssistantThread />
          </div>
          <AssistantComposer disabled={!isConnected} error={error} />
          <div className="flex justify-center bg-kumo-base pb-3">
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </ThreadRenderProvider>
      </ThinkRuntimeProvider>

    </div>
  );
}

function AuthShell({
  children,
  align = "center"
}: {
  children: ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className="flex flex-col min-h-screen bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="flex items-center justify-end">
          <ModeToggle />
        </div>
      </header>
      <div
        className={`flex-1 py-12 ${
          align === "center" ? "flex items-center justify-center" : ""
        }`}
      >
        <div className="w-full max-w-lg px-6">{children}</div>
      </div>
      <div className="flex justify-center pb-3">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </div>
    </div>
  );
}

function LoadingView({ message = "Loading..." }: { message?: string }) {
  return (
    <AuthShell>
      <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
            <ShieldCheckIcon
              size={20}
              weight="bold"
              className="text-kumo-brand"
            />
          </div>
          <Text variant="heading1" as="h1">
            Assistant
          </Text>
        </div>
        <Text variant="secondary">{message}</Text>
      </Surface>
    </AuthShell>
  );
}

function SignInView({ error }: { error: string | null }) {
  return (
    <AuthShell>
      <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
              <GithubLogoIcon
                size={20}
                weight="fill"
                className="text-kumo-brand"
              />
            </div>
            <Text variant="heading1" as="h1">
              Assistant
            </Text>
          </div>
          <Text variant="secondary">
            Sign in with GitHub, then connect to a user-scoped Think assistant
            chosen by the Worker. No local token storage, no browser-chosen room
            names.
          </Text>
        </div>

        <Surface className="p-4 rounded-xl ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="text-kumo-accent shrink-0 mt-0.5"
            />
            <div>
              <Text size="sm" bold>
                Before you start
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  Create a GitHub OAuth App and add `GITHUB_CLIENT_ID` plus
                  `GITHUB_CLIENT_SECRET` to `.env`. The README walks through the
                  exact callback URL to use for local development.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        {error && (
          <div className="mt-6">
            <Banner variant="error">{error}</Banner>
          </div>
        )}

        <div className="border-t border-kumo-line my-8" />

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          icon={<GithubLogoIcon size={18} weight="fill" />}
          onClick={startGitHubLogin}
        >
          Sign in with GitHub
        </Button>
      </Surface>
    </AuthShell>
  );
}

// ── Sidebar (chat list + new-chat action) ──────────────────────────────

function ChatSidebar({
  chats,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  open,
  onClose,
  user,
  onSignOut
}: {
  chats: ChatSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (chat: ChatSummary) => void;
  onDelete: (chat: ChatSummary) => void;
  open: boolean;
  onClose: () => void;
  user: AuthUser;
  onSignOut: () => Promise<void>;
}) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const displayName = user.name || user.login;

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await onSignOut();
    } catch (err) {
      console.error("Failed to sign out:", err);
    } finally {
      setIsSigningOut(false);
    }
  }, [onSignOut]);

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex h-full w-72 shrink-0 flex-col border-r border-kumo-line bg-kumo-base shadow-xl transition-transform md:static md:z-auto md:w-64 md:translate-x-0 md:shadow-none ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="px-3 py-3 border-b border-kumo-line flex items-center gap-2">
        <RobotIcon size={20} className="text-kumo-brand" />
        <h1 className="text-sm font-semibold text-kumo-default">Assistant</h1>
        <Badge variant="secondary">Think</Badge>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          className="ml-auto md:hidden"
          aria-label="关闭聊天列表"
          icon={<XIcon size={15} />}
          onClick={onClose}
        />
      </div>

      <div className="px-3 py-2 border-b border-kumo-line">
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={14} />}
          onClick={onCreate}
          className="w-full"
        >
          New chat
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <VirtualList
          items={chats}
          getItemKey={(chat) => chat.id}
          estimateSize={() => 64}
          overscan={6}
          aria-label="聊天列表"
          className="h-full py-1"
          itemClassName="px-1"
          emptyState={
            <div className="p-4 flex flex-col items-center text-center gap-2">
              <ChatsIcon size={24} className="text-kumo-inactive" />
              <Text size="xs" variant="secondary">
                No chats yet. Click <strong>New chat</strong> to start one.
              </Text>
            </div>
          }
          renderItem={(chat) => {
            const isActive = chat.id === activeId;
            return (
                <div className="group relative">
                  <button
                    aria-label={`Select chat ${chat.title}`}
                    type="button"
                    className={`w-full flex items-start gap-1 px-2 py-2 rounded-md text-left ${
                      isActive ? "bg-kumo-hover" : "hover:bg-kumo-hover/60"
                    }`}
                    onClick={() => onSelect(chat.id)}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <Text size="sm" bold>
                        <span className="truncate block">{chat.title}</span>
                      </Text>
                      <span className="mt-0.5 truncate block">
                        <Text size="xs" variant="secondary">
                          {chat.lastMessagePreview ?? "No messages yet"}
                        </Text>
                      </span>
                    </div>
                  </button>
                  {/* Row actions sit outside the main button so nested
                      buttons don't get flagged as a11y violations. */}
                  <div className="absolute right-2 top-2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      aria-label="Rename chat"
                      icon={<PencilIcon size={12} />}
                      onClick={() => onRename(chat)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      aria-label="Delete chat"
                      icon={<TrashIcon size={12} />}
                      onClick={() => onDelete(chat)}
                    />
                  </div>
                </div>
            );
          }}
        />
      </div>

      <div className="px-3 py-3 border-t border-kumo-line flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <GithubLogoIcon size={14} className="text-kumo-inactive shrink-0" />
          <Text size="xs" variant="secondary">
            <span className="truncate block">{displayName}</span>
          </Text>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <ModeToggle />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="Sign out"
            icon={<SignOutIcon size={14} />}
            onClick={handleSignOut}
            loading={isSigningOut}
          />
        </div>
      </div>
    </aside>
  );
}

// ── Multi-chat shell (sidebar + active chat) ───────────────────────────

function MultiChatApp({
  user,
  onSignOut
}: {
  user: AuthUser;
  onSignOut: () => void;
}) {
  const {
    directory,
    chats,
    workspaceRevision,
    documentRevision,
    storyRevision,
    mcpState,
    createChat,
    renameChat,
    deleteChat,
    addMcpServer,
    removeMcpServer
  } = useChats();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [storyPanelOpen, setStoryPanelOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ChatSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [chatActionBusy, setChatActionBusy] = useState(false);
  const [chatActionError, setChatActionError] = useState<string | null>(null);

  // Auto-select the most-recently-active chat when the sidebar loads or
  // when the currently-active chat is deleted from under us. The
  // directory's state is the source of truth — we never invent an id
  // client-side.
  useEffect(() => {
    if (chats.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !chats.some((c) => c.id === activeId)) {
      setActiveId(chats[0].id);
    }
  }, [chats, activeId]);

  const handleCreate = useCallback(async () => {
    try {
      const created = await createChat();
      setActiveId(created.id);
      setSidebarOpen(false);
    } catch (err) {
      console.error("Failed to create chat:", err);
    }
  }, [createChat]);

  const handleRename = useCallback(
    (chat: ChatSummary) => {
      setChatActionError(null);
      setRenameTarget(chat);
      setRenameDraft(chat.title);
    },
    []
  );

  const confirmRename = useCallback(async () => {
    if (!renameTarget || chatActionBusy) return;
    const title = normalizedRename(renameTarget.title, renameDraft);
    if (!title) return;
    setChatActionBusy(true);
    setChatActionError(null);
    try {
      await renameChat(renameTarget.id, title);
      setRenameTarget(null);
    } catch (err) {
      console.error("Failed to rename chat:", err);
      setChatActionError(
        `重命名失败：${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setChatActionBusy(false);
    }
  }, [chatActionBusy, renameChat, renameDraft, renameTarget]);

  const handleDelete = useCallback((chat: ChatSummary) => {
    setChatActionError(null);
    setDeleteTarget(chat);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || chatActionBusy) return;
    setChatActionBusy(true);
    setChatActionError(null);
    try {
      await deleteChat(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      console.error("Failed to delete chat:", err);
      setChatActionError(
        `删除失败：${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setChatActionBusy(false);
    }
  }, [chatActionBusy, deleteChat, deleteTarget]);

  /*
   * Rename and delete are intentionally split into explicit product dialogs.
   * This keeps async/busy/error state visible and avoids blocking native UI.
   */
  const closeChatAction = useCallback(() => {
    if (chatActionBusy) return;
    setRenameTarget(null);
    setDeleteTarget(null);
    setChatActionError(null);
  }, [chatActionBusy]);

  const activeChat =
    activeId !== null ? chats.find((c) => c.id === activeId) : undefined;
  const directoryReady = directory.readyState === 1;

  const handleSignOut = useCallback(async () => {
    try {
      await signOut();
    } finally {
      onSignOut();
    }
  }, [onSignOut]);

  return (
    <>
      <div className="relative flex h-screen bg-kumo-elevated">
      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          aria-label="关闭聊天列表"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <ChatSidebar
        chats={chats}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          setSidebarOpen(false);
        }}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        user={user}
        onSignOut={handleSignOut}
      />
      <div className="flex min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          {activeChat ? (
          // `key={activeChat.id}` forces a full remount across chat
          // switches so the chat's local state (MCP panel, file browser,
          // branch map, input draft) all reset cleanly.
          <Suspense
            key={activeChat.id}
            fallback={<LoadingView message="Loading chat…" />}
          >
            <Chat
              chatId={activeChat.id}
              chatTitle={activeChat.title}
              workspaceRevision={workspaceRevision}
              sharedDocumentRevision={documentRevision}
              mcpState={mcpState}
              addMcpServer={addMcpServer}
              removeMcpServer={removeMcpServer}
              onOpenSidebar={() => setSidebarOpen(true)}
              storyPanelOpen={storyPanelOpen}
              onToggleStoryPanel={() => setStoryPanelOpen((open) => !open)}
              onRequestRename={() => handleRename(activeChat)}
              onRequestDelete={() => handleDelete(activeChat)}
            />
          </Suspense>
          ) : (
          <EmptyChatView
            ready={directoryReady}
            onCreate={handleCreate}
            hasChats={chats.length > 0}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
          )}
        </div>
        {storyPanelOpen && (
          <aside className="fixed inset-0 z-50 min-w-0 border-l border-kumo-line md:relative md:inset-auto md:z-auto md:w-[min(52vw,56rem)] md:shrink-0">
            <StoryPanel
              revision={storyRevision}
              onClose={() => setStoryPanelOpen(false)}
            />
          </aside>
        )}
      </div>
      </div>
      <ProductPromptDialog
        open={renameTarget !== null}
        title="重命名聊天"
        description="聊天记录和 Agent 状态不会改变，只更新列表中显示的名称。"
        label="聊天名称"
        value={renameDraft}
        confirmLabel="保存名称"
        busy={chatActionBusy}
        confirmDisabled={
          renameTarget === null ||
          normalizedRename(renameTarget.title, renameDraft) === null
        }
        error={chatActionError}
        onValueChange={setRenameDraft}
        onOpenChange={(open) => {
          if (!open) closeChatAction();
        }}
        onConfirm={() => void confirmRename()}
      />
      <ProductConfirmDialog
        open={deleteTarget !== null}
        title="删除这个聊天？"
        description="聊天消息、分支和该聊天的 Agent 状态都会永久删除，此操作无法撤销。"
        confirmLabel="确认删除"
        destructive
        busy={chatActionBusy}
        error={chatActionError}
        details={deleteTarget?.title}
        onOpenChange={(open) => {
          if (!open) closeChatAction();
        }}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

function EmptyChatView({
  ready,
  onCreate,
  hasChats,
  onOpenSidebar
}: {
  ready: boolean;
  onCreate: () => void;
  hasChats: boolean;
  onOpenSidebar: () => void;
}) {
  if (!ready) {
    return <LoadingView message="Connecting…" />;
  }
  if (hasChats) {
    // Transient — the sidebar auto-selects a chat on the next tick.
    return <LoadingView message="Opening chat…" />;
  }
  return (
    <div className="relative h-full flex items-center justify-center p-8">
      <Button
        variant="ghost"
        shape="square"
        className="absolute left-3 top-3 md:hidden"
        aria-label="打开聊天列表"
        icon={<ListIcon size={18} />}
        onClick={onOpenSidebar}
      />
      <div className="max-w-md flex flex-col items-center gap-4">
        <Empty
          icon={<ChatsIcon size={28} />}
          title="No chats yet"
          description="Files and MCP servers are shared across every chat. Messages and extensions stay per-chat."
        />
        <Button
          variant="primary"
          icon={<PlusIcon size={14} />}
          onClick={onCreate}
        >
          New chat
        </Button>
      </div>
    </div>
  );
}

function AuthenticatedApp() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const loadUser = async () => {
      try {
        const currentUser = await fetchCurrentUser(controller.signal);
        setUser(currentUser);
        setError(null);
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        ) {
          return;
        }
        setUser(null);
        setError("Failed to load the current auth state");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadUser();
    return () => controller.abort();
  }, []);

  if (isLoading) {
    return <LoadingView message="Checking your authentication status…" />;
  }

  if (user) {
    return (
      <MultiChatApp
        user={user}
        onSignOut={() => {
          setUser(null);
          setError(null);
        }}
      />
    );
  }

  return <SignInView error={error} />;
}

export default function App() {
  return <AuthenticatedApp />;
}

const rootElement = document.getElementById("root")!;
const clientGlobal = globalThis as typeof globalThis & {
  __helloThinkReactRoot?: ReturnType<typeof createRoot>;
};
const appRoot =
  clientGlobal.__helloThinkReactRoot ?? createRoot(rootElement);
clientGlobal.__helloThinkReactRoot = appRoot;
appRoot.render(<App />);
