import { MAX_INDEXED_DOCUMENT_CHARS } from "./document-library";

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml"
]);

export type ParsedDocument = {
  text: string;
  pageCount?: number;
};

const MAX_PDF_PAGES = 2_000;
const TEXT_DECODE_CHUNK_BYTES = 64 * 1024;
const TEXT_BUFFER_FLUSH_CHARS = 64 * 1024;

class ParsedTextLimitError extends Error {}

class BoundedTextAccumulator {
  private readonly parts: string[] = [];
  private buffer: string[] = [];
  private bufferLength = 0;
  length = 0;

  append(value: string): void {
    if (!value) return;
    if (this.length + value.length > MAX_INDEXED_DOCUMENT_CHARS) {
      throw new ParsedTextLimitError(
        "解析后的文本超过 400 万字符；请拆分文件或接入外部解析服务"
      );
    }
    this.buffer.push(value);
    this.bufferLength += value.length;
    this.length += value.length;
    if (this.bufferLength >= TEXT_BUFFER_FLUSH_CHARS) this.flush();
  }

  toString(): string {
    this.flush();
    return this.parts.join("");
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    this.parts.push(this.buffer.join(""));
    this.buffer = [];
    this.bufferLength = 0;
  }
}

export function isTextDocument(mimeType: string, fileName: string): boolean {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]!.trim();
  if (normalized.startsWith("text/") || TEXT_MIME_TYPES.has(normalized)) {
    return true;
  }

  return /\.(?:txt|md|mdx|csv|tsv|json|jsonl|xml|ya?ml|html?|css|js|jsx|ts|tsx|py|java|go|rs|sql|log)$/i.test(
    fileName
  );
}

/**
 * Convert a stored attachment into searchable text. PDF page boundaries are
 * retained as explicit markers so retrieved chunks can still point the model
 * at the originating page without putting the whole PDF in its context.
 */
export async function parseDocumentBytes(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string
): Promise<ParsedDocument> {
  const normalizedMime = mimeType.toLowerCase().split(";", 1)[0]!.trim();

  if (normalizedMime === "application/pdf" || /\.pdf$/i.test(fileName)) {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    try {
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new Error(`PDF 页数超过 ${MAX_PDF_PAGES} 页，请拆分后上传`);
      }

      const output = new BoundedTextAccumulator();
      let extractedChars = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        output.append(`\n\n--- 第 ${pageNumber} 页 ---\n\n`);
        const page = await pdf.getPage(pageNumber);
        try {
          const reader = page.streamTextContent().getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const items = (value as PdfTextChunk | undefined)?.items ?? [];
              for (const item of items) {
                if (typeof item.str !== "string") continue;
                const value = item.str + (item.hasEOL ? "\n" : "");
                output.append(value);
                extractedChars += value.length;
              }
            }
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
          } finally {
            reader.releaseLock();
          }
        } finally {
          page.cleanup();
        }
      }
      if (extractedChars === 0) {
        throw new Error("PDF 没有可提取文本；扫描件需要接入 OCR");
      }
      return { pageCount: pdf.numPages, text: output.toString() };
    } finally {
      await pdf.destroy();
    }
  }

  if (isTextDocument(normalizedMime, fileName)) {
    return { text: decodeText(bytes) };
  }

  if (normalizedMime.startsWith("image/")) {
    return {
      text:
        `图片附件：${fileName}\n` +
        "原始图片已保存，但当前演示模型未启用视觉识别或 OCR；可在文档面板中查看或下载。"
    };
  }

  throw new Error(`暂不支持解析 ${mimeType || "未知类型"} 文件`);
}

function decodeText(bytes: Uint8Array): string {
  const encoding = hasPrefix(bytes, [0xff, 0xfe])
    ? "utf-16le"
    : hasPrefix(bytes, [0xfe, 0xff])
      ? "utf-16be"
      : "utf-8";
  const output = new BoundedTextAccumulator();
  try {
    const decoder = new TextDecoder(encoding, { fatal: true });
    for (
      let offset = 0;
      offset < bytes.length;
      offset += TEXT_DECODE_CHUNK_BYTES
    ) {
      const end = Math.min(bytes.length, offset + TEXT_DECODE_CHUNK_BYTES);
      output.append(
        decoder.decode(bytes.subarray(offset, end), {
          stream: end < bytes.length
        })
      );
    }
    output.append(decoder.decode());
    return output.toString();
  } catch (error) {
    if (error instanceof ParsedTextLimitError) throw error;
    throw new Error(
      "文本编码无法识别；请使用 UTF-8，或带 BOM 的 UTF-16 LE/BE 文件"
    );
  }
}

type PdfTextChunk = {
  items: Array<{ str?: string; hasEOL?: boolean }>;
};

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}
