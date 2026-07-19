import type { AppendMessage, CompleteAttachment } from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  assistantMessageToThinkMessage,
  createThinkRuntimeAdapter,
  defaultThinkAttachmentMapper,
  thinkMessageToThreadMessage,
  type ThinkAgentChat
} from "../chat/think-runtime";

describe("thinkMessageToThreadMessage", () => {
  it("converts user files into assistant-ui attachments", () => {
    const message: UIMessage = {
      id: "user-1",
      role: "user",
      parts: [
        { type: "text", text: "看看这张图" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "demo.png",
          url: "data:image/png;base64,AAAA"
        }
      ]
    };

    expect(thinkMessageToThreadMessage(message)).toEqual({
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "看看这张图" }],
      attachments: [
        {
          id: "user-1-attachment-0",
          type: "image",
          name: "demo.png",
          contentType: "image/png",
          status: { type: "complete" },
          content: [
            {
              type: "image",
              image: "data:image/png;base64,AAAA",
              filename: "demo.png"
            }
          ]
        }
      ]
    });
  });

  it("converts assistant reasoning, tools and streaming status", () => {
    const message: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "先分析" },
        {
          type: "dynamic-tool",
          toolName: "fetch_url",
          toolCallId: "tool-1",
          state: "output-available",
          input: { url: "https://example.com" },
          output: { ok: true }
        },
        { type: "text", text: "完成" }
      ]
    };

    expect(
      thinkMessageToThreadMessage(message, { isRunning: true })
    ).toEqual({
      id: "assistant-1",
      role: "assistant",
      content: [
        { type: "reasoning", text: "先分析" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "fetch_url",
          argsText: '{"url":"https://example.com"}',
          result: { ok: true }
        },
        { type: "text", text: "完成" }
      ],
      status: { type: "running" }
    });
  });
});

describe("assistantMessageToThinkMessage", () => {
  it("maps uploaded attachments into AI SDK file parts before text", () => {
    const attachment: CompleteAttachment = {
      id: "upload-1",
      type: "image",
      name: "photo.png",
      contentType: "image/png",
      status: { type: "complete" },
      content: [
        {
          type: "image",
          image: "data:image/png;base64,BBBB",
          filename: "photo.png"
        }
      ]
    };
    const message = {
      role: "user",
      content: [{ type: "text", text: "描述它" }],
      attachments: [attachment]
    } satisfies Pick<AppendMessage, "role" | "content" | "attachments">;

    expect(assistantMessageToThinkMessage(message)).toEqual({
      role: "user",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,BBBB",
          mediaType: "image/png",
          filename: "photo.png"
        },
        { type: "text", text: "描述它" }
      ]
    });
  });

  it("exposes an overridable attachment mapper", () => {
    const attachment: CompleteAttachment = {
      id: "doc-1",
      type: "document",
      name: "notes.txt",
      contentType: "text/plain",
      status: { type: "complete" },
      content: [{ type: "text", text: "hello" }]
    };

    expect(defaultThinkAttachmentMapper(attachment)).toEqual([
      { type: "text", text: "hello" }
    ]);
  });
});

describe("createThinkRuntimeAdapter", () => {
  it("bridges Think running, send and cancel commands", async () => {
    const sent: unknown[] = [];
    let cancelCount = 0;
    const chat = {
      messages: [],
      status: "ready",
      isStreaming: false,
      isRecovering: true,
      sendMessage: async (message: unknown) => {
        sent.push(message);
      },
      stop: async () => {
        cancelCount += 1;
      }
    } as unknown as ThinkAgentChat;
    const adapter = createThinkRuntimeAdapter(chat);

    await adapter.onNew({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      attachments: []
    } as AppendMessage);
    await adapter.onCancel?.();

    expect(adapter.isRunning).toBe(true);
    expect(sent).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      }
    ]);
    expect(cancelCount).toBe(1);
  });

  it("bridges regeneration and tool approval exactly once", async () => {
    let regenerateCount = 0;
    const approvals: { id: string; approved: boolean }[] = [];
    const chat = {
      messages: [],
      status: "ready",
      isStreaming: false,
      isRecovering: false,
      sendMessage: async () => undefined,
      stop: async () => undefined,
      regenerate: async () => {
        regenerateCount += 1;
      },
      addToolApprovalResponse: async (approval: {
        id: string;
        approved: boolean;
      }) => {
        approvals.push(approval);
      }
    } as unknown as ThinkAgentChat;
    const adapter = createThinkRuntimeAdapter(chat);

    await adapter.onReload?.(null);
    await adapter.onRespondToToolApproval?.({
      approvalId: "approval-1",
      approved: true
    });

    expect(regenerateCount).toBe(1);
    expect(approvals).toEqual([{ id: "approval-1", approved: true }]);
  });
});
