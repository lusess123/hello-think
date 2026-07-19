import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type CompleteAttachment,
  type DictationAdapter,
  type ExternalStoreAdapter,
  type SpeechSynthesisAdapter,
  type ThreadMessageLike
} from "@assistant-ui/react";
import type { useAgentChat } from "@cloudflare/think/react";
import {
  getToolName,
  isToolUIPart,
  type CreateUIMessage,
  type UIMessage
} from "ai";
import type { PropsWithChildren } from "react";

export type ThinkAgentChat = Pick<
  ReturnType<typeof useAgentChat>,
  | "messages"
  | "sendMessage"
  | "stop"
  | "regenerate"
  | "addToolApprovalResponse"
  | "status"
  | "isStreaming"
  | "isRecovering"
>;

export type ThinkUploadPart =
  | Extract<UIMessage["parts"][number], { type: "text" | "file" }>
  | { type: `data-${string}`; data: unknown };

export type ThinkAttachmentMapper = (
  attachment: CompleteAttachment
) => readonly ThinkUploadPart[];

export type ThinkRuntimeOptions = {
  attachmentAdapter?: AttachmentAdapter;
  dictationAdapter?: DictationAdapter;
  speechAdapter?: SpeechSynthesisAdapter;
  mapAttachment?: ThinkAttachmentMapper;
  isDisabled?: boolean;
};

export type ThinkRuntimeProviderProps = PropsWithChildren<
  ThinkRuntimeOptions & {
    chat: ThinkAgentChat;
  }
>;

type AssistantContentPart = Exclude<
  ThreadMessageLike["content"],
  string
>[number];
type AssistantAttachment = NonNullable<
  ThreadMessageLike["attachments"]
>[number];
type ThinkPart = UIMessage["parts"][number];
type ThinkFilePart = Extract<ThinkPart, { type: "file" }>;
type ThinkToolPart = Parameters<typeof getToolName>[0];

const toAttachmentName = (part: ThinkFilePart, index: number) =>
  part.filename ?? `attachment-${index + 1}`;

const toAssistantFilePart = (
  part: ThinkFilePart
): Extract<AssistantContentPart, { type: "image" | "file" }> => {
  if (part.mediaType.startsWith("image/")) {
    return {
      type: "image",
      image: part.url,
      filename: part.filename
    };
  }

  return {
    type: "file",
    data: part.url,
    mimeType: part.mediaType,
    filename: part.filename
  };
};

const toAssistantAttachment = (
  part: ThinkFilePart,
  messageId: string,
  index: number
): AssistantAttachment => ({
  id: `${messageId}-attachment-${index}`,
  type: part.mediaType.startsWith("image/") ? "image" : "document",
  name: toAttachmentName(part, index),
  contentType: part.mediaType,
  status: { type: "complete" },
  content: [toAssistantFilePart(part)]
});

const stringifyToolInput = (input: unknown) => {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
};

const toAssistantToolPart = (
  part: ThinkToolPart
): Extract<AssistantContentPart, { type: "tool-call" }> => {
  const approval =
    "approval" in part && part.approval
      ? {
          id: part.approval.id,
          ...(typeof part.approval.approved === "boolean"
            ? { approved: part.approval.approved }
            : {}),
          ...(part.approval.reason ? { reason: part.approval.reason } : {})
        }
      : undefined;
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";
  const wasDenied = part.state === "output-denied";

  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: getToolName(part),
    argsText: stringifyToolInput(part.input),
    ...(hasOutput ? { result: part.output } : {}),
    ...(hasError ? { result: part.errorText, isError: true } : {}),
    ...(wasDenied ? { result: "Tool execution denied", isError: true } : {}),
    ...(approval ? { approval } : {})
  };
};

const toAssistantContentPart = (
  part: ThinkPart,
  role: UIMessage["role"]
): AssistantContentPart | null => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return role === "assistant"
        ? { type: "reasoning", text: part.text }
        : null;
    case "file":
      return role === "assistant" ? toAssistantFilePart(part) : null;
    case "source-url":
      return role === "assistant"
        ? {
            type: "source",
            sourceType: "url",
            id: part.sourceId,
            url: part.url,
            title: part.title
          }
        : null;
    case "source-document":
      return role === "assistant"
        ? {
            type: "source",
            sourceType: "document",
            id: part.sourceId,
            title: part.title,
            mediaType: part.mediaType,
            filename: part.filename
          }
        : null;
    case "step-start":
      return null;
    default:
      if (isToolUIPart(part)) {
        return role === "assistant" ? toAssistantToolPart(part) : null;
      }
      if (part.type.startsWith("data-")) {
        return { type: part.type, data: part.data };
      }
      return null;
  }
};

export const thinkMessageToThreadMessage = (
  message: UIMessage,
  options: { isRunning?: boolean } = {}
): ThreadMessageLike => {
  if (message.role === "system") {
    return {
      id: message.id,
      role: "system",
      content: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    };
  }

  const content = message.parts
    .map((part) => toAssistantContentPart(part, message.role))
    .filter((part): part is AssistantContentPart => part !== null);

  if (message.role === "user") {
    const attachments = message.parts
      .filter((part): part is ThinkFilePart => part.type === "file")
      .map((part, index) =>
        toAssistantAttachment(part, message.id, index)
      );

    return {
      id: message.id,
      role: "user",
      content,
      attachments
    };
  }

  return {
    id: message.id,
    role: "assistant",
    content,
    status: options.isRunning
      ? { type: "running" }
      : { type: "complete", reason: "stop" }
  };
};

const dataUrlMediaType = (value: string) =>
  /^data:([^;,]+)/.exec(value)?.[1];

const toThinkPart = (
  part: CompleteAttachment["content"][number]
): ThinkUploadPart | null => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "file",
        url: part.image,
        mediaType: dataUrlMediaType(part.image) ?? "image/*",
        filename: part.filename
      };
    case "file":
      return {
        type: "file",
        url: part.data,
        mediaType: part.mimeType,
        filename: part.filename
      };
    case "data":
      return { type: `data-${part.name}`, data: part.data };
    default:
      return null;
  }
};

export const defaultThinkAttachmentMapper: ThinkAttachmentMapper = (
  attachment
) =>
  attachment.content
    .map(toThinkPart)
    .filter((part): part is ThinkUploadPart => part !== null);

export const assistantMessageToThinkMessage = (
  message: Pick<AppendMessage, "role" | "content" | "attachments">,
  mapAttachment: ThinkAttachmentMapper = defaultThinkAttachmentMapper
): CreateUIMessage<UIMessage> => {
  if (message.role !== "user") {
    throw new Error("Think runtime only sends user messages");
  }

  const attachmentParts = (message.attachments ?? []).flatMap((attachment) =>
    mapAttachment(attachment)
  );
  const contentParts = (message.content as CompleteAttachment["content"])
    .map(toThinkPart)
    .filter((part): part is ThinkUploadPart => part !== null);

  return {
    role: "user",
    parts: [...attachmentParts, ...contentParts]
  };
};

export const isThinkChatRunning = (chat: ThinkAgentChat) =>
  chat.isStreaming ||
  chat.isRecovering ||
  chat.status === "submitted" ||
  chat.status === "streaming";

export const createThinkRuntimeAdapter = (
  chat: ThinkAgentChat,
  options: ThinkRuntimeOptions = {}
): ExternalStoreAdapter<UIMessage> => {
  const isRunning = isThinkChatRunning(chat);

  return {
    messages: chat.messages,
    isRunning,
    isDisabled: options.isDisabled,
    convertMessage: (message, index) =>
      thinkMessageToThreadMessage(message, {
        isRunning:
          isRunning &&
          index === chat.messages.length - 1 &&
          message.role === "assistant"
      }),
    onNew: async (message) => {
      await chat.sendMessage(
        assistantMessageToThinkMessage(message, options.mapAttachment)
      );
    },
    onCancel: async () => {
      await chat.stop();
    },
    onReload: async () => {
      await chat.regenerate();
    },
    onRespondToToolApproval: async ({ approvalId, approved }) => {
      await chat.addToolApprovalResponse({ id: approvalId, approved });
    },
    adapters:
      options.attachmentAdapter || options.dictationAdapter || options.speechAdapter
        ? {
            attachments: options.attachmentAdapter,
            dictation: options.dictationAdapter,
            speech: options.speechAdapter
          }
        : undefined
  };
};

export const useThinkRuntime = (
  chat: ThinkAgentChat,
  options: ThinkRuntimeOptions = {}
) => useExternalStoreRuntime(createThinkRuntimeAdapter(chat, options));

export const ThinkRuntimeProvider = ({
  chat,
  attachmentAdapter,
  dictationAdapter,
  speechAdapter,
  mapAttachment,
  isDisabled,
  children
}: ThinkRuntimeProviderProps) => {
  const runtime = useThinkRuntime(chat, {
    attachmentAdapter,
    dictationAdapter,
    speechAdapter,
    mapAttachment,
    isDisabled
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
};
