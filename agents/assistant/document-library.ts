const DEFAULT_CHUNK_TOKENS = 1000;
const MIN_CHUNK_TOKENS = 800;
const MAX_CHUNK_TOKENS = 1200;
const DEFAULT_OVERLAP_TOKENS = 120;
const DEFAULT_SEARCH_TOKENS = 4000;
const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_INDEXED_DOCUMENT_CHARS = 4_000_000;
const SEARCH_INDEX_FORMAT_KEY = "search_index_format";
const SEARCH_INDEX_FORMAT_VERSION = "2";
const CJK_CHARACTER_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHARACTER_RE = /[\p{L}\p{N}_]/u;

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface CreateDocumentInput {
  id?: string;
  name: string;
  mimeType: string;
  sourceUrl?: string | null;
  storagePath?: string | null;
  sizeBytes?: number | null;
}

export interface DocumentRecord {
  id: string;
  name: string;
  mimeType: string;
  status: DocumentStatus;
  sourceUrl: string | null;
  storagePath: string | null;
  sizeBytes: number | null;
  normalizedChars: number;
  tokenEstimate: number;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  processedAt: number | null;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  index: number;
  content: string;
  startOffset: number;
  endOffset: number;
  tokenEstimate: number;
}

export interface SearchDocumentsOptions {
  /** Maximum number of chunks returned. Defaults to 8, capped at 20. */
  limit?: number;
  /** Maximum approximate tokens across all returned chunk text. */
  maxTokens?: number;
  /** Optional document allowlist. */
  documentIds?: string[];
}

export interface DocumentCitation {
  id: string;
  documentId: string;
  documentName: string;
  mimeType: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  label: string;
}

export interface DocumentSearchHit {
  content: string;
  tokenEstimate: number;
  score: number;
  truncated: boolean;
  citation: DocumentCitation;
}

export interface SearchDocumentsResult {
  query: string;
  hits: DocumentSearchHit[];
  usedTokens: number;
  maxTokens: number;
}

type DocumentRow = {
  id: string;
  name: string;
  mime_type: string;
  status: DocumentStatus;
  source_url: string | null;
  storage_path: string | null;
  size_bytes: number | null;
  normalized_chars: number;
  token_estimate: number;
  chunk_count: number;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  processed_at: number | null;
};

type ChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  start_offset: number;
  end_offset: number;
  token_estimate: number;
};

type SearchRow = ChunkRow & {
  document_name: string;
  mime_type: string;
  score: number;
};

/**
 * Durable, text-first document index for a single Durable Object.
 *
 * Original bytes live outside this class (normally R2). The library stores
 * document metadata and normalized text chunks in Durable Object SQLite, then
 * indexes chunk text with FTS5. PDF/OCR parsing is deliberately a caller
 * responsibility: create the PDF metadata first, then pass extracted text to
 * processDocument().
 */
export class DocumentLibrary {
  constructor(private readonly sql: SqlStorage) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        mime_type        TEXT NOT NULL,
        status           TEXT NOT NULL
                         CHECK(status IN ('pending','processing','ready','failed')),
        source_url       TEXT,
        storage_path     TEXT,
        size_bytes       INTEGER,
        normalized_chars INTEGER NOT NULL DEFAULT 0,
        token_estimate   INTEGER NOT NULL DEFAULT 0,
        chunk_count      INTEGER NOT NULL DEFAULT 0,
        error_message    TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        processed_at     INTEGER
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS documents_status_updated
      ON documents(status, updated_at DESC)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id             TEXT PRIMARY KEY,
        document_id    TEXT NOT NULL,
        chunk_index    INTEGER NOT NULL,
        content        TEXT NOT NULL,
        start_offset   INTEGER NOT NULL,
        end_offset     INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        UNIQUE(document_id, chunk_index),
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS document_chunks_document
      ON document_chunks(document_id, chunk_index)
    `);
    this.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
        content,
        document_id UNINDEXED,
        chunk_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS document_library_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.ensureSearchIndexFormat();
  }

  /** Rebuild legacy raw-text FTS rows into the CJK-aware search format. */
  private ensureSearchIndexFormat(): void {
    const current = first(
      this.sql.exec<{ value: string }>(
        "SELECT value FROM document_library_meta WHERE key = ?",
        SEARCH_INDEX_FORMAT_KEY
      )
    );
    if (current?.value === SEARCH_INDEX_FORMAT_VERSION) return;

    this.sql.exec("DELETE FROM document_chunks_fts");
    const chunks = this.sql.exec<{
      id: string;
      document_id: string;
      content: string;
    }>(
      `SELECT id, document_id, content
       FROM document_chunks
       ORDER BY document_id, chunk_index`
    );
    for (const chunk of chunks) {
      this.sql.exec(
        `INSERT INTO document_chunks_fts(content, document_id, chunk_id)
         VALUES (?, ?, ?)`,
        buildSearchIndexText(chunk.content),
        chunk.document_id,
        chunk.id
      );
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO document_library_meta(key, value)
       VALUES (?, ?)`,
      SEARCH_INDEX_FORMAT_KEY,
      SEARCH_INDEX_FORMAT_VERSION
    );
  }

  createDocument(input: CreateDocumentInput): DocumentRecord {
    const name = requiredText(input.name, "name");
    const mimeType = requiredText(input.mimeType, "mimeType").toLowerCase();
    const id = input.id?.trim() || crypto.randomUUID();
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO documents (
         id, name, mime_type, status, source_url, storage_path, size_bytes,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      id,
      name,
      mimeType,
      nullableText(input.sourceUrl),
      nullableText(input.storagePath),
      normalizeSize(input.sizeBytes),
      now,
      now
    );

    return this.requireDocument(id);
  }

  getDocument(id: string): DocumentRecord | null {
    const row = first(
      this.sql.exec<DocumentRow>("SELECT * FROM documents WHERE id = ?", id)
    );
    return row ? mapDocument(row) : null;
  }

  listDocuments(options: {
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  } = {}): DocumentRecord[] {
    const limit = clampInteger(options.limit ?? 50, 1, 200);
    const offset = clampInteger(options.offset ?? 0, 0, 1_000_000);
    const rows = options.status
      ? this.sql.exec<DocumentRow>(
          `SELECT * FROM documents
           WHERE status = ?
           ORDER BY updated_at DESC, id ASC
           LIMIT ? OFFSET ?`,
          options.status,
          limit,
          offset
        )
      : this.sql.exec<DocumentRow>(
          `SELECT * FROM documents
           ORDER BY updated_at DESC, id ASC
           LIMIT ? OFFSET ?`,
          limit,
          offset
        );
    return [...rows].map(mapDocument);
  }

  markDocument(
    id: string,
    status: Exclude<DocumentStatus, "ready">,
    errorMessage: string | null = null
  ): DocumentRecord {
    this.requireDocument(id);
    const error = status === "failed" ? boundedError(errorMessage) : null;
    this.sql.exec(
      `UPDATE documents
       SET status = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      status,
      error,
      Date.now(),
      id
    );
    return this.requireDocument(id);
  }

  markProcessing(id: string): DocumentRecord {
    return this.markDocument(id, "processing");
  }

  markFailed(id: string, error: unknown): DocumentRecord {
    return this.markDocument(id, "failed", errorMessage(error));
  }

  /** Replace any previous index with chunks made from caller-normalized text. */
  processDocument(id: string, normalizedText: string): DocumentRecord {
    this.requireDocument(id);
    this.markProcessing(id);

    try {
      if (normalizedText.length > MAX_INDEXED_DOCUMENT_CHARS) {
        throw new Error(
          "解析后的文本超过 400 万字符；请拆分文件或接入外部解析服务"
        );
      }
      const text = normalizeText(normalizedText);
      if (!text) throw new Error("normalizedText must not be empty");

      const chunks = chunkDocumentText(text);
      this.clearChunks(id);

      for (const chunk of chunks) {
        const chunkId = `${id}:${chunk.index}`;
        this.sql.exec(
          `INSERT INTO document_chunks (
             id, document_id, chunk_index, content, start_offset, end_offset,
             token_estimate
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          chunkId,
          id,
          chunk.index,
          chunk.content,
          chunk.startOffset,
          chunk.endOffset,
          chunk.tokenEstimate
        );
        this.sql.exec(
          `INSERT INTO document_chunks_fts(content, document_id, chunk_id)
           VALUES (?, ?, ?)`,
          buildSearchIndexText(chunk.content),
          id,
          chunkId
        );
      }

      const now = Date.now();
      this.sql.exec(
        `UPDATE documents
         SET status = 'ready', normalized_chars = ?, token_estimate = ?,
             chunk_count = ?, error_message = NULL, updated_at = ?,
             processed_at = ?
         WHERE id = ?`,
        text.length,
        estimateDocumentTokens(text),
        chunks.length,
        now,
        now,
        id
      );
      return this.requireDocument(id);
    } catch (error) {
      this.clearChunks(id);
      this.markFailed(id, error);
      throw error;
    }
  }

  listChunks(
    documentId: string,
    options: { limit?: number; offset?: number } = {}
  ): DocumentChunk[] {
    const limit = clampInteger(options.limit ?? 100, 1, 500);
    const offset = clampInteger(options.offset ?? 0, 0, 1_000_000);
    return [
      ...this.sql.exec<ChunkRow>(
        `SELECT * FROM document_chunks
         WHERE document_id = ?
         ORDER BY chunk_index ASC
         LIMIT ? OFFSET ?`,
        documentId,
        limit,
        offset
      )
    ].map(mapChunk);
  }

  searchDocuments(
    rawQuery: string,
    options: SearchDocumentsOptions = {}
  ): SearchDocumentsResult {
    const query = rawQuery.trim();
    const maxTokens = clampInteger(
      options.maxTokens ?? DEFAULT_SEARCH_TOKENS,
      1,
      50_000
    );
    if (!query) return { query, hits: [], usedTokens: 0, maxTokens };

    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return { query, hits: [], usedTokens: 0, maxTokens };

    const limit = clampInteger(options.limit ?? DEFAULT_SEARCH_LIMIT, 1, 20);
    const documentIds = [...new Set(options.documentIds ?? [])]
      .filter(Boolean)
      .slice(0, 50);
    const candidateLimit = Math.min(100, Math.max(limit * 4, 20));
    const filter = documentIds.length
      ? ` AND c.document_id IN (${documentIds.map(() => "?").join(",")})`
      : "";
    const rows = this.sql.exec<SearchRow>(
      `SELECT c.*, d.name AS document_name, d.mime_type,
              bm25(document_chunks_fts) AS score
       FROM document_chunks_fts
       JOIN document_chunks c ON c.id = document_chunks_fts.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE document_chunks_fts MATCH ?
         AND d.status = 'ready'${filter}
       ORDER BY score ASC, c.document_id ASC, c.chunk_index ASC
       LIMIT ?`,
      ftsQuery,
      ...documentIds,
      candidateLimit
    );

    const hits: DocumentSearchHit[] = [];
    let usedTokens = 0;
    for (const row of rows) {
      if (hits.length >= limit || usedTokens >= maxTokens) break;
      const remaining = maxTokens - usedTokens;
      if (row.token_estimate <= remaining) {
        hits.push(mapSearchHit(row, row.content, row.token_estimate, false));
        usedTokens += row.token_estimate;
      } else if (hits.length === 0) {
        const content = truncateToTokenBudget(row.content, remaining);
        const tokens = estimateDocumentTokens(content);
        if (content && tokens > 0) {
          hits.push(mapSearchHit(row, content, tokens, true));
          usedTokens += tokens;
        }
      }
    }

    return { query, hits, usedTokens, maxTokens };
  }

  deleteDocument(id: string): boolean {
    if (!this.getDocument(id)) return false;
    this.clearChunks(id);
    this.sql.exec("DELETE FROM documents WHERE id = ?", id);
    return true;
  }

  private clearChunks(documentId: string): void {
    this.sql.exec(
      "DELETE FROM document_chunks_fts WHERE document_id = ?",
      documentId
    );
    this.sql.exec(
      "DELETE FROM document_chunks WHERE document_id = ?",
      documentId
    );
  }

  private requireDocument(id: string): DocumentRecord {
    const document = this.getDocument(id);
    if (!document) throw new Error(`Document not found: ${id}`);
    return document;
  }
}

/** Workers-safe approximation used for chunking and query budgets. */
export function estimateDocumentTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let wordRuns = 0;
  let inWord = false;
  for (const character of text) {
    if (isCjkCharacter(character)) cjk++;
    const wordCharacter = isWordCharacter(character);
    if (wordCharacter && !inWord) wordRuns++;
    inWord = wordCharacter;
  }
  return estimateTokensFromMetrics(text.length, cjk, wordRuns);
}

export function chunkDocumentText(text: string): DocumentChunk[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const chunks: DocumentChunk[] = [];
  let start = 0;
  while (start < normalized.length) {
    const boundaries = scanChunkTokenBoundaries(normalized, start);
    let end = boundaries.maxEnd;
    if (boundaries.maxEnd < normalized.length) {
      end = findNaturalBoundary(
        normalized,
        boundaries.minEnd,
        boundaries.targetEnd
      );
      if (end <= start) end = boundaries.targetEnd;
    }

    const content = normalized.slice(start, end);
    chunks.push({
      id: "",
      documentId: "",
      index: chunks.length,
      content,
      startOffset: start,
      endOffset: end,
      tokenEstimate: estimateDocumentTokens(content)
    });

    if (end >= normalized.length) break;
    const overlapStart = suffixStartForTokens(
      normalized,
      start,
      end,
      DEFAULT_OVERLAP_TOKENS
    );
    start = overlapStart > start ? overlapStart : end;
  }
  return chunks;
}

type ChunkTokenBoundaries = {
  minEnd: number;
  targetEnd: number;
  maxEnd: number;
};

function scanChunkTokenBoundaries(
  text: string,
  start: number
): ChunkTokenBoundaries {
  let end = start;
  let minEnd = start;
  let targetEnd = start;
  let maxEnd = start;
  let cjk = 0;
  let wordRuns = 0;
  let inWord = false;

  while (end < text.length) {
    const character = codePointAt(text, end);
    const nextEnd = end + character.length;
    if (isCjkCharacter(character)) cjk++;
    const wordCharacter = isWordCharacter(character);
    if (wordCharacter && !inWord) wordRuns++;
    inWord = wordCharacter;

    const estimate = estimateTokensFromMetrics(
      nextEnd - start,
      cjk,
      wordRuns
    );
    if (estimate > MAX_CHUNK_TOKENS) break;

    maxEnd = nextEnd;
    if (minEnd === start && estimate >= MIN_CHUNK_TOKENS) {
      minEnd = nextEnd;
    }
    if (estimate <= DEFAULT_CHUNK_TOKENS) targetEnd = nextEnd;
    end = nextEnd;
  }

  if (targetEnd === start) targetEnd = maxEnd;
  if (minEnd === start) minEnd = Math.min(targetEnd, maxEnd);
  return { minEnd, targetEnd, maxEnd };
}

function findNaturalBoundary(text: string, minEnd: number, targetEnd: number): number {
  let boundary = targetEnd;
  while (boundary > minEnd) {
    const previousStart = previousCodePointStart(text, boundary);
    const previous = text.slice(previousStart, boundary);
    const current = codePointAt(text, boundary);
    if (previous === "\n" && current === "\n") return boundary + 1;
    if (/[。！？.!?；;\n]/u.test(previous)) return boundary;
    boundary = previousStart;
  }

  boundary = targetEnd;
  while (boundary > minEnd) {
    const previousStart = previousCodePointStart(text, boundary);
    const previous = text.slice(previousStart, boundary);
    if (/\s/u.test(previous)) return boundary;
    boundary = previousStart;
  }
  return targetEnd;
}

function suffixStartForTokens(
  text: string,
  chunkStart: number,
  chunkEnd: number,
  budget: number
): number {
  let best = chunkEnd;
  let start = chunkEnd;
  let cjk = 0;
  let wordRuns = 0;
  let inWord = false;

  while (start > chunkStart) {
    const previousStart = previousCodePointStart(text, start);
    const character = text.slice(previousStart, start);
    const nextCjk = cjk + (isCjkCharacter(character) ? 1 : 0);
    const wordCharacter = isWordCharacter(character);
    const nextWordRuns =
      wordRuns + (wordCharacter && !inWord ? 1 : 0);
    const estimate = estimateTokensFromMetrics(
      chunkEnd - previousStart,
      nextCjk,
      nextWordRuns
    );
    if (estimate > budget) break;

    best = previousStart;
    start = previousStart;
    cjk = nextCjk;
    wordRuns = nextWordRuns;
    inWord = wordCharacter;
  }

  const boundaryCeiling = Math.min(chunkEnd, best + 80);
  let boundary = best;
  while (boundary < boundaryCeiling) {
    const character = codePointAt(text, boundary);
    boundary += character.length;
    if (/\s/u.test(character)) return boundary;
  }
  return best;
}

function truncateToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (estimateDocumentTokens(text) <= budget) return text;
  const end = endForTokenBudget(text, 0, budget);
  return text.slice(0, end).trimEnd();
}

function toFtsQuery(query: string): string {
  const phrases = searchSegments(query).map((segment) =>
    quoteFtsPhrase(searchTokens(segment))
  );
  return [...new Set(phrases)]
    .filter(Boolean)
    .slice(0, 16)
    .join(" OR ");
}

function buildSearchIndexText(text: string): string {
  return searchSegments(text).flatMap(searchTokens).join(" ");
}

type SearchSegment = {
  kind: "cjk" | "word";
  value: string;
};

function searchSegments(value: string): SearchSegment[] {
  const segments: SearchSegment[] = [];
  let kind: SearchSegment["kind"] | null = null;
  let current = "";

  const flush = () => {
    if (kind && current) segments.push({ kind, value: current });
    kind = null;
    current = "";
  };

  for (const character of value.normalize("NFKC")) {
    const nextKind = isCjkCharacter(character)
      ? "cjk"
      : isWordCharacter(character)
        ? "word"
        : null;
    if (!nextKind) {
      flush();
    } else if (kind === nextKind) {
      current += character;
    } else {
      flush();
      kind = nextKind;
      current = character;
    }
  }
  flush();
  return segments;
}

function searchTokens(segment: SearchSegment): string[] {
  if (segment.kind === "word") return [segment.value];
  const characters = [...segment.value];
  if (characters.length <= 1) return characters;
  return characters.slice(0, -1).map((character, index) => {
    return character + characters[index + 1];
  });
}

function quoteFtsPhrase(tokens: string[]): string {
  if (!tokens.length) return "";
  return `"${tokens.join(" ").replaceAll('"', '""')}"`;
}

function endForTokenBudget(text: string, start: number, budget: number): number {
  let end = start;
  let best = start;
  let cjk = 0;
  let wordRuns = 0;
  let inWord = false;

  while (end < text.length) {
    const character = codePointAt(text, end);
    const nextEnd = end + character.length;
    if (isCjkCharacter(character)) cjk++;
    const wordCharacter = isWordCharacter(character);
    if (wordCharacter && !inWord) wordRuns++;
    inWord = wordCharacter;
    if (
      estimateTokensFromMetrics(nextEnd - start, cjk, wordRuns) > budget
    ) {
      break;
    }
    best = nextEnd;
    end = nextEnd;
  }
  return best;
}

function estimateTokensFromMetrics(
  codeUnits: number,
  cjk: number,
  wordRuns: number
): number {
  const characterEstimate = cjk + Math.max(0, codeUnits - cjk) / 4;
  const wordEstimate = cjk + wordRuns * 1.3;
  return Math.ceil(Math.max(characterEstimate, wordEstimate));
}

function isCjkCharacter(character: string): boolean {
  return CJK_CHARACTER_RE.test(character);
}

function isWordCharacter(character: string): boolean {
  return WORD_CHARACTER_RE.test(character);
}

function codePointAt(text: string, index: number): string {
  if (index >= text.length) return "";
  return String.fromCodePoint(text.codePointAt(index)!);
}

function previousCodePointStart(text: string, index: number): number {
  let start = Math.max(0, index - 1);
  const codeUnit = text.charCodeAt(start);
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 0) {
    const previous = text.charCodeAt(start - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) start--;
  }
  return start;
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    status: row.status,
    sourceUrl: row.source_url,
    storagePath: row.storage_path,
    sizeBytes: row.size_bytes,
    normalizedChars: row.normalized_chars,
    tokenEstimate: row.token_estimate,
    chunkCount: row.chunk_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processedAt: row.processed_at
  };
}

function mapChunk(row: ChunkRow): DocumentChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    index: row.chunk_index,
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    tokenEstimate: row.token_estimate
  };
}

function mapSearchHit(
  row: SearchRow,
  content: string,
  tokenEstimate: number,
  truncated: boolean
): DocumentSearchHit {
  const endOffset = truncated
    ? row.start_offset + content.length
    : row.end_offset;
  return {
    content,
    tokenEstimate,
    score: row.score,
    truncated,
    citation: {
      id: `${row.document_id}#chunk-${row.chunk_index + 1}`,
      documentId: row.document_id,
      documentName: row.document_name,
      mimeType: row.mime_type,
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset,
      label: `${row.document_name} · chunk ${row.chunk_index + 1}`
    }
  };
}

function first<T>(cursor: Iterable<T>): T | undefined {
  for (const row of cursor) return row;
  return undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replaceAll("\u0000", "").trim();
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function normalizeSize(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("sizeBytes must be a non-negative finite number");
  }
  return Math.floor(value);
}

function boundedError(value: string | null): string {
  return (value?.trim() || "Document processing failed").slice(0, 4000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
