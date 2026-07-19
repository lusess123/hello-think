import { describe, expect, it } from "vitest";
import {
  isTextDocument,
  parseDocumentBytes
} from "../../agents/assistant/document-parser";
import { MAX_INDEXED_DOCUMENT_CHARS } from "../../agents/assistant/document-library";

const encode = (value: string) => new TextEncoder().encode(value);

describe("isTextDocument", () => {
  it.each([
    ["TEXT/PLAIN; charset=UTF-8", "attachment.bin"],
    ["application/json", "attachment.bin"],
    ["application/LD+JSON; profile=test", "attachment.bin"],
    ["application/x-yaml", "attachment.bin"],
    ["application/octet-stream", "README.MD"],
    ["application/octet-stream", "events.jsonl"],
    ["application/octet-stream", "component.TSX"]
  ])("accepts supported MIME or extension: %s / %s", (mimeType, fileName) => {
    expect(isTextDocument(mimeType, fileName)).toBe(true);
  });

  it.each([
    ["application/octet-stream", "archive.zip"],
    ["application/octet-stream", "notes.txt.exe"],
    ["image/png", "screen.png"],
    ["application/pdf", "report.pdf"]
  ])("rejects non-text inputs: %s / %s", (mimeType, fileName) => {
    expect(isTextDocument(mimeType, fileName)).toBe(false);
  });
});

describe("parseDocumentBytes — text", () => {
  it("decodes UTF-8 text and ignores MIME parameters", async () => {
    const source = "# 访谈摘要\n\n用户说：保持简单直接。🙂";

    await expect(
      parseDocumentBytes(
        encode(source),
        "TEXT/MARKDOWN; charset=UTF-8",
        "summary.bin"
      )
    ).resolves.toEqual({ text: source });
  });

  it("uses a supported file extension when MIME is generic", async () => {
    const source = '{"event":"uploaded","ok":true}\n';

    await expect(
      parseDocumentBytes(
        encode(source),
        "application/octet-stream",
        "events.JSONL"
      )
    ).resolves.toEqual({ text: source });
  });

  it("returns empty decoded text and leaves empty-content validation upstream", async () => {
    await expect(
      parseDocumentBytes(new Uint8Array(), "text/plain", "empty.txt")
    ).resolves.toEqual({ text: "" });
  });

  it("decodes BOM-marked UTF-16 text", async () => {
    const source = "大文件编码测试";
    const bytes = new Uint8Array(2 + source.length * 2);
    bytes.set([0xff, 0xfe]);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < source.length; index++) {
      view.setUint16(2 + index * 2, source.charCodeAt(index), true);
    }

    await expect(
      parseDocumentBytes(bytes, "text/plain", "utf16.txt")
    ).resolves.toEqual({ text: source });
  });

  it("rejects invalid UTF-8 instead of silently indexing replacement characters", async () => {
    await expect(
      parseDocumentBytes(
        new Uint8Array([0xc3, 0x28]),
        "text/plain",
        "broken.txt"
      )
    ).rejects.toThrow("文本编码无法识别");
  });

  it("decodes a multi-byte character split across streaming decoder chunks", async () => {
    const source = `${"a".repeat(65_535)}🙂结尾`;

    await expect(
      parseDocumentBytes(encode(source), "text/plain", "streamed.txt")
    ).resolves.toEqual({ text: source });
  });

  it("rejects extracted text above the bounded indexing limit", async () => {
    const bytes = new Uint8Array(MAX_INDEXED_DOCUMENT_CHARS + 1).fill(0x61);

    await expect(
      parseDocumentBytes(bytes, "text/plain", "too-large.txt")
    ).rejects.toThrow("解析后的文本超过 400 万字符");
  });
});

describe("parseDocumentBytes — images", () => {
  it("preserves the image name and reports the current OCR capability boundary", async () => {
    const result = await parseDocumentBytes(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "IMAGE/PNG; charset=binary",
      "访谈截图.png"
    );

    expect(result).toEqual({
      text:
        "图片附件：访谈截图.png\n" +
        "原始图片已保存，但当前演示模型未启用视觉识别或 OCR；可在文档面板中查看或下载。"
    });
    expect(result.pageCount).toBeUndefined();
  });
});

describe("parseDocumentBytes — PDF", () => {
  it("extracts a real PDF one page at a time and keeps the page marker", async () => {
    const result = await parseDocumentBytes(
      createMinimalPdf("Hello PDF evidence"),
      "application/pdf",
      "evidence.pdf"
    );

    expect(result.pageCount).toBe(1);
    expect(result.text).toContain("--- 第 1 页 ---");
    expect(result.text).toContain("Hello PDF evidence");
  });
});

describe("parseDocumentBytes — error boundaries", () => {
  it("rejects an unsupported binary type with a useful message", async () => {
    await expect(
      parseDocumentBytes(
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        "application/zip",
        "archive.zip"
      )
    ).rejects.toThrow("暂不支持解析 application/zip 文件");
  });

  it("uses the unknown-type label when MIME metadata is absent", async () => {
    await expect(
      parseDocumentBytes(new Uint8Array([0xff]), "", "attachment.bin")
    ).rejects.toThrow("暂不支持解析 未知类型 文件");
  });

  it("routes a PDF extension through the PDF parser and rejects corrupt bytes", async () => {
    await expect(
      parseDocumentBytes(
        encode("this is not a valid PDF"),
        "text/plain",
        "broken.PDF"
      )
    ).rejects.toThrow();
  });
});

function createMinimalPdf(text: string): Uint8Array {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return encode(pdf);
}
