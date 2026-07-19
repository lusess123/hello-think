import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  chunkDocumentText,
  DocumentLibrary,
  estimateDocumentTokens,
  MAX_INDEXED_DOCUMENT_CHARS
} from "../../agents/assistant/document-library";
import { uniqueDirectoryName } from "./helpers";

async function inDocumentLibrary<T>(
  callback: (library: DocumentLibrary, sql: SqlStorage) => T | Promise<T>
): Promise<T> {
  const stub = env.AssistantDirectory.get(
    env.AssistantDirectory.idFromName(uniqueDirectoryName("documents"))
  );
  return runInDurableObject(stub, (_instance, state) =>
    callback(new DocumentLibrary(state.storage.sql), state.storage.sql)
  );
}

describe("DocumentLibrary", () => {
  it("tracks PDF metadata and explicit processing states", async () => {
    const result = await inDocumentLibrary((library) => {
      const created = library.createDocument({
        id: "report",
        name: "年度报告.pdf",
        mimeType: "application/pdf",
        storagePath: "/documents/report.pdf",
        sizeBytes: 12_345_678
      });
      const processing = library.markProcessing(created.id);
      const failed = library.markFailed(created.id, "OCR service unavailable");
      return { created, processing, failed };
    });

    expect(result.created).toMatchObject({
      id: "report",
      name: "年度报告.pdf",
      mimeType: "application/pdf",
      status: "pending",
      storagePath: "/documents/report.pdf",
      sizeBytes: 12_345_678,
      chunkCount: 0
    });
    expect(result.processing.status).toBe("processing");
    expect(result.failed).toMatchObject({
      status: "failed",
      errorMessage: "OCR service unavailable"
    });
  });

  it("normalizes and indexes long text as overlapping 800-1200 token chunks", async () => {
    const text = Array.from(
      { length: 6_000 },
      (_, index) => `paragraph${index % 37} evidence${index}`
    ).join(" ");

    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "long-text",
        name: "research.txt",
        mimeType: "text/plain"
      });
      const document = library.processDocument("long-text", text);
      const chunks = library.listChunks("long-text", { limit: 500 });
      return { document, chunks };
    });

    expect(result.document.status).toBe("ready");
    expect(result.document.chunkCount).toBe(result.chunks.length);
    expect(result.chunks.length).toBeGreaterThan(10);
    expect(result.document.tokenEstimate).toBe(estimateDocumentTokens(text));

    for (const [index, chunk] of result.chunks.entries()) {
      expect(chunk.index).toBe(index);
      expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(1200);
      if (index < result.chunks.length - 1) {
        expect(chunk.tokenEstimate).toBeGreaterThanOrEqual(800);
        expect(result.chunks[index + 1].startOffset).toBeLessThan(
          chunk.endOffset
        );
      }
    }
  });

  it("searches ready chunks within a query budget and returns citations", async () => {
    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "helium",
        name: "Helium launch notes",
        mimeType: "text/markdown"
      });
      library.processDocument(
        "helium",
        "The orbital helium protocol requires a blue launch checklist. ".repeat(
          300
        )
      );

      library.createDocument({
        id: "garden",
        name: "Garden notes",
        mimeType: "text/plain"
      });
      library.processDocument(
        "garden",
        "Tomatoes need warm soil and regular watering. ".repeat(300)
      );

      return library.searchDocuments("orbital helium", {
        limit: 5,
        maxTokens: 1_700
      });
    });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThanOrEqual(5);
    expect(result.usedTokens).toBeLessThanOrEqual(1_700);
    expect(
      result.hits.every((hit) => hit.citation.documentId === "helium")
    ).toBe(true);
    expect(result.hits[0].citation).toMatchObject({
      documentName: "Helium launch notes",
      mimeType: "text/markdown",
      chunkIndex: expect.any(Number),
      startOffset: expect.any(Number),
      endOffset: expect.any(Number)
    });
    expect(result.hits[0].citation.id).toMatch(/^helium#chunk-/);
  });

  it("finds two-character Chinese substrings inside continuous Chinese text", async () => {
    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "refund-policy",
        name: "退款说明.md",
        mimeType: "text/markdown"
      });
      library.processDocument(
        "refund-policy",
        "这里介绍退款政策说明以及售后处理流程。兼容码ＡＢＣ。"
      );

      return {
        twoCharacters: library.searchDocuments("退款"),
        longerPhrase: library.searchDocuments("退款政策"),
        normalizedLatin: library.searchDocuments("ABC")
      };
    });

    expect(result.twoCharacters.hits).toHaveLength(1);
    expect(result.longerPhrase.hits).toHaveLength(1);
    expect(result.twoCharacters.hits[0].content).toContain("退款政策说明");
    expect(result.normalizedLatin.hits).toHaveLength(1);
  });

  it("rebuilds legacy FTS rows when the search index format changes", async () => {
    const result = await inDocumentLibrary((library, sql) => {
      library.createDocument({
        id: "legacy-fts",
        name: "旧索引.txt",
        mimeType: "text/plain"
      });
      library.processDocument("legacy-fts", "连续中文里的退款政策说明");

      const [chunk] = library.listChunks("legacy-fts");
      sql.exec("DELETE FROM document_chunks_fts WHERE document_id = ?", "legacy-fts");
      sql.exec(
        `INSERT INTO document_chunks_fts(content, document_id, chunk_id)
         VALUES (?, ?, ?)`,
        chunk.content,
        "legacy-fts",
        chunk.id
      );
      sql.exec(
        "DELETE FROM document_library_meta WHERE key = ?",
        "search_index_format"
      );

      const beforeMigration = library.searchDocuments("退款");
      const migrated = new DocumentLibrary(sql);
      const afterMigration = migrated.searchDocuments("退款");
      return { beforeMigration, afterMigration };
    });

    expect(result.beforeMigration.hits).toEqual([]);
    expect(result.afterMigration.hits).toHaveLength(1);
    expect(result.afterMigration.hits[0].citation.documentId).toBe("legacy-fts");
  });

  it("clips the first matching chunk when the query budget is smaller", async () => {
    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "budget",
        name: "Budget test",
        mimeType: "text/plain"
      });
      library.processDocument(
        "budget",
        "quartz searchable evidence and supporting details ".repeat(500)
      );
      return library.searchDocuments("quartz", {
        maxTokens: 120,
        limit: 3
      });
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].truncated).toBe(true);
    expect(result.hits[0].tokenEstimate).toBeLessThanOrEqual(120);
    expect(result.usedTokens).toBeLessThanOrEqual(120);
    expect(result.hits[0].citation.endOffset).toBe(
      result.hits[0].citation.startOffset + result.hits[0].content.length
    );
  });

  it("reprocessing replaces the old FTS index", async () => {
    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "replace",
        name: "Mutable notes",
        mimeType: "text/plain"
      });
      library.processDocument(
        "replace",
        "legacykeyword belongs to the old version"
      );
      library.processDocument(
        "replace",
        "currentkeyword belongs to the replacement version"
      );
      return {
        old: library.searchDocuments("legacykeyword"),
        current: library.searchDocuments("currentkeyword"),
        chunks: library.listChunks("replace")
      };
    });

    expect(result.old.hits).toEqual([]);
    expect(result.current.hits).toHaveLength(1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("currentkeyword");
  });

  it("marks empty normalized text as failed without searchable chunks", async () => {
    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "empty",
        name: "empty.txt",
        mimeType: "text/plain"
      });
      let message = "";
      try {
        library.processDocument("empty", "\r\n  \u0000  ");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return {
        message,
        document: library.getDocument("empty"),
        chunks: library.listChunks("empty")
      };
    });

    expect(result.message).toBe("normalizedText must not be empty");
    expect(result.document).toMatchObject({
      status: "failed",
      errorMessage: "normalizedText must not be empty",
      chunkCount: 0
    });
    expect(result.chunks).toEqual([]);
  });

  it("rejects direct callers that bypass the parser text-size limit", async () => {
    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "oversized-text",
        name: "oversized.txt",
        mimeType: "text/plain"
      });
      expect(() =>
        library.processDocument(
          "oversized-text",
          "x".repeat(MAX_INDEXED_DOCUMENT_CHARS + 1)
        )
      ).toThrow("解析后的文本超过 400 万字符");
      return library.getDocument("oversized-text");
    });

    expect(result).toMatchObject({ status: "failed", chunkCount: 0 });
  });

  it("deletes metadata, chunks, and FTS matches idempotently", async () => {
    const result = await inDocumentLibrary((library) => {
      library.createDocument({
        id: "delete-me",
        name: "Disposable",
        mimeType: "text/plain"
      });
      library.processDocument("delete-me", "uniquedeletionterm");
      const firstDelete = library.deleteDocument("delete-me");
      const secondDelete = library.deleteDocument("delete-me");
      return {
        firstDelete,
        secondDelete,
        document: library.getDocument("delete-me"),
        chunks: library.listChunks("delete-me"),
        search: library.searchDocuments("uniquedeletionterm")
      };
    });

    expect(result.firstDelete).toBe(true);
    expect(result.secondDelete).toBe(false);
    expect(result.document).toBeNull();
    expect(result.chunks).toEqual([]);
    expect(result.search.hits).toEqual([]);
  });

  it("never splits UTF-16 surrogate pairs at chunk or overlap boundaries", () => {
    const source = `a${"𠀀".repeat(4_000)}z`;
    const chunks = chunkDocumentText(source);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(chunk.content).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(chunk.content).toBe(source.slice(chunk.startOffset, chunk.endOffset));
    }
  });

  it(
    "chunks multi-megabyte text within a bounded linear-time envelope",
    () => {
      const source = "alpha beta 中文证据。".repeat(220_000);
      const startedAt = performance.now();
      const chunks = chunkDocumentText(source);
      const elapsedMs = performance.now() - startedAt;

      expect(source.length).toBeGreaterThan(3_000_000);
      expect(chunks.length).toBeGreaterThan(500);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(chunks.every((chunk) => chunk.tokenEstimate <= 1_200)).toBe(true);
    },
    10_000
  );
});
