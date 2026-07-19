import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment
} from "@assistant-ui/react";
import type { DocumentRecord } from "../../agents/assistant/document-library";
import { apiFetch, apiUrl } from "../api-client";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type UploadedDocument = {
  document: DocumentRecord;
  contentUrl: string;
};

export type DocumentAttachmentData = {
  documentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  status: DocumentRecord["status"];
  contentUrl: string;
  kind: "image" | "pdf" | "text" | "file";
};

export class DocumentAttachmentAdapter implements AttachmentAdapter {
  accept =
    "image/*,application/pdf,text/*,application/json,application/xml,application/yaml,.md,.mdx,.csv,.tsv,.jsonl,.yaml,.yml";

  private readonly uploads = new Map<string, UploadedDocument>();

  constructor(
    private readonly onDocumentChange?: (document: DocumentRecord) => void
  ) {}

  async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment> {
    const id = crypto.randomUUID();
    const base = {
      id,
      type: file.type.startsWith("image/") ? "image" : "document",
      name: file.name,
      contentType: file.type || "application/octet-stream",
      file
    } satisfies Omit<PendingAttachment, "status">;

    if (file.size > MAX_UPLOAD_BYTES) {
      yield {
        ...base,
        status: {
          type: "incomplete",
          reason: "error",
          message: "单文件上传上限为 100 MB"
        }
      };
      return;
    }

    const progressQueue: number[] = [0];
    let wake: (() => void) | undefined;
    let result: UploadedDocument | undefined;
    let uploadError: Error | undefined;
    let settled = false;

    void uploadDocument(file, (progress) => {
      progressQueue.push(progress);
      wake?.();
      wake = undefined;
    })
      .then((uploaded) => {
        result = uploaded;
      })
      .catch((error) => {
        uploadError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        settled = true;
        wake?.();
        wake = undefined;
      });

    while (!settled || progressQueue.length > 0) {
      if (progressQueue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const progress = progressQueue.shift()!;
      yield {
        ...base,
        status: { type: "running", reason: "uploading", progress }
      };
    }

    if (uploadError || !result) {
      yield {
        ...base,
        status: {
          type: "incomplete",
          reason: "error",
          message: uploadError?.message ?? "上传失败"
        }
      };
      return;
    }

    this.uploads.set(id, result);
    this.onDocumentChange?.(result.document);
    yield {
      ...base,
      status: { type: "requires-action", reason: "composer-send" }
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const uploaded = this.uploads.get(attachment.id);
    if (!uploaded) throw new Error("附件尚未上传完成");
    const { document, contentUrl } = uploaded;
    const data: DocumentAttachmentData = {
      documentId: document.id,
      name: document.name,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      status: document.status,
      contentUrl,
      kind: documentKind(document.mimeType, document.name)
    };

    return {
      ...attachment,
      status: { type: "complete" },
      content: [
        { type: "data", name: "document", data },
        {
          type: "text",
          text:
            `\n[已上传文档：${document.name}；document_id=${document.id}；` +
            "回答前请使用 search_documents 检索相关片段。]"
        }
      ]
    };
  }

  async remove(attachment: Attachment): Promise<void> {
    const uploaded = this.uploads.get(attachment.id);
    if (!uploaded) return;
    const response = await apiFetch(
      `/chat/documents/${encodeURIComponent(uploaded.document.id)}`,
      { method: "DELETE" }
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`删除已上传附件失败（HTTP ${response.status}）`);
    }
    this.uploads.delete(attachment.id);
  }
}

function documentKind(
  mimeType: string,
  name: string
): DocumentAttachmentData["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mimeType.startsWith("text/") || mimeType.includes("json")) return "text";
  return "file";
}

function uploadDocument(
  file: File,
  onProgress: (progress: number) => void
): Promise<UploadedDocument> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/chat/documents"));
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream"
    );
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      onProgress(Math.min(1, event.loaded / event.total));
    });
    xhr.addEventListener("load", () => {
      const body = xhr.response as
        | UploadedDocument
        | { error?: string }
        | null;
      if (xhr.status >= 200 && xhr.status < 300 && body && "document" in body) {
        onProgress(1);
        resolve({ ...body, contentUrl: apiUrl(body.contentUrl) });
        return;
      }
      reject(
        new Error(
          body && "error" in body && body.error
            ? body.error
            : `上传失败（HTTP ${xhr.status}）`
        )
      );
    });
    xhr.addEventListener("error", () => reject(new Error("上传网络错误")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));
    xhr.send(file);
  });
}
