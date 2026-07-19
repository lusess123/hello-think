import {
  ArrowsClockwiseIcon,
  FilePdfIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DocumentRecord,
  DocumentSearchHit
} from "../../agents/assistant/document-library";
import { VirtualList } from "../components/virtual-list";
import { ProductConfirmDialog } from "../components/product-dialog";

export function DocumentPanel({
  revision,
  onClose
}: {
  revision: number;
  onClose: () => void;
}) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocumentSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const [removing, setRemoving] = useState(false);
  const refreshRequestRef = useRef(0);
  const searchRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    setError(null);
    try {
      const nextDocuments = await fetchAllDocuments();
      if (requestId === refreshRequestRef.current) {
        setDocuments(nextDocuments);
      }
    } catch (refreshError) {
      if (requestId === refreshRequestRef.current) {
        setError(`读取文档库失败：${errorMessage(refreshError)}`);
      }
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  useEffect(() => {
    if (
      !documents.some(
        (doc) => doc.status === "pending" || doc.status === "processing"
      )
    ) {
      return;
    }
    const timer = window.setTimeout(() => void refresh(), 2_000);
    return () => window.clearTimeout(timer);
  }, [documents, refresh]);

  const search = useCallback(async () => {
    const value = query.trim();
    const requestId = ++searchRequestRef.current;
    if (!value) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const response = await fetch(
        `/chat/documents/search?q=${encodeURIComponent(value)}&limit=20&maxTokens=8000`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { hits: DocumentSearchHit[] };
      if (requestId === searchRequestRef.current) setHits(body.hits);
    } catch (searchError) {
      if (requestId === searchRequestRef.current) {
        setHits([]);
        setError(`搜索失败：${errorMessage(searchError)}`);
      }
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false);
    }
  }, [query]);

  const remove = useCallback(
    async () => {
      const document = pendingDelete;
      if (!document || removing) return;
      setRemoving(true);
      setError(null);
      try {
        const response = await fetch(
          `/chat/documents/${encodeURIComponent(document.id)}`,
          { method: "DELETE" }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setDocuments((current) =>
          current.filter((item) => item.id !== document.id)
        );
        setHits((current) =>
          current.filter((hit) => hit.citation.documentId !== document.id)
        );
        setPendingDelete(null);
      } catch (removeError) {
        setError(`删除失败：${errorMessage(removeError)}`);
      } finally {
        setRemoving(false);
      }
    },
    [pendingDelete, removing]
  );

  const retry = useCallback(async (document: DocumentRecord) => {
    setError(null);
    try {
      const response = await fetch(
        `/chat/documents/${encodeURIComponent(document.id)}/retry`,
        { method: "POST" }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { document: DocumentRecord };
      setDocuments((current) =>
        current.map((item) => (item.id === document.id ? body.document : item))
      );
    } catch (retryError) {
      setError(`重试失败：${errorMessage(retryError)}`);
    }
  }, []);

  return (
    <>
      <Surface className="w-[min(30rem,calc(100vw-2rem))] rounded-xl p-4 shadow-xl ring ring-kumo-line">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileTextIcon size={17} className="text-kumo-brand" />
          <Text size="sm" bold>
            文档库
          </Text>
          <Badge variant="secondary">{documents.length}</Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="关闭文档库"
          icon={<XIcon size={14} />}
          onClick={onClose}
        />
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          value={query}
          onChange={(event) => {
            searchRequestRef.current++;
            setQuery(event.target.value);
            setHits([]);
            setSearching(false);
            setError(null);
          }}
          placeholder="搜索所有已索引文档"
          aria-label="搜索文档"
          className="min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-kumo-focus"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={searching}
          icon={<MagnifyingGlassIcon size={14} />}
        >
          搜索
        </Button>
      </form>

      {error && (
        <div
          role="alert"
          className="mt-2 rounded-lg bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger"
        >
          {error}
        </div>
      )}

      {query.trim() && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">
            检索结果
          </div>
          <VirtualList
            items={hits}
            getItemKey={(hit) => hit.citation.id}
            estimateSize={() => 104}
            overscan={3}
            aria-label="文档搜索结果"
            className="max-h-64 rounded-lg border border-kumo-line"
            itemClassName="p-2"
            emptyState={
              <div className="p-4 text-center text-xs text-kumo-subtle">
                {searching ? "搜索中…" : "没有匹配片段"}
              </div>
            }
            renderItem={(hit) => (
              <div className="rounded-md bg-kumo-elevated p-2 text-xs">
                <div className="font-medium">{hit.citation.label}</div>
                <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-kumo-subtle">
                  {hit.content}
                </div>
              </div>
            )}
          />
        </div>
      )}

      <div className="mt-3 mb-1 text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">
        原始文件与索引
      </div>
      <VirtualList
        items={documents}
        getItemKey={(document) => document.id}
        estimateSize={() => 88}
        overscan={4}
        aria-label="文档列表"
        aria-busy={loading}
        className="max-h-80 rounded-lg border border-kumo-line"
        itemClassName="p-2"
        emptyState={
          <div className="p-5 text-center text-xs text-kumo-subtle">
            {loading ? "正在加载文档…" : "把 PDF、文本或图片拖入输入框即可上传"}
          </div>
        }
        renderItem={(document) => (
          <div className="flex items-start gap-2 rounded-md p-1 hover:bg-kumo-fill-hover/60">
            {document.mimeType === "application/pdf" ? (
              <FilePdfIcon size={20} className="mt-0.5 shrink-0 text-kumo-brand" />
            ) : (
              <FileTextIcon size={20} className="mt-0.5 shrink-0 text-kumo-brand" />
            )}
            <a
              href={`/chat/documents/${encodeURIComponent(document.id)}/content`}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1"
            >
              <span className="block truncate text-sm font-medium text-kumo-default hover:underline">
                {document.name}
              </span>
              <span className="mt-0.5 block text-xs text-kumo-subtle">
                {formatBytes(document.sizeBytes)} · {statusLabel(document)}
              </span>
              {document.errorMessage && (
                <span className="mt-1 line-clamp-2 block text-xs text-kumo-danger">
                  {document.errorMessage}
                </span>
              )}
            </a>
            <div className="flex shrink-0 gap-1">
              {document.status === "failed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  aria-label={`重试 ${document.name}`}
                  icon={<ArrowsClockwiseIcon size={13} />}
                  onClick={() => void retry(document)}
                />
              )}
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                aria-label={`删除 ${document.name}`}
                icon={<TrashIcon size={13} />}
                onClick={() => setPendingDelete(document)}
              />
            </div>
          </div>
        )}
      />
      </Surface>
      <ProductConfirmDialog
        open={pendingDelete !== null}
        title="删除文档及索引？"
        description="原始文件、解析文本和全部检索块都会一起删除，此操作无法撤销。"
        confirmLabel="确认删除"
        destructive
        busy={removing}
        details={
          pendingDelete
            ? `${pendingDelete.name} · ${formatBytes(pendingDelete.sizeBytes)}`
            : undefined
        }
        onOpenChange={(open) => {
          if (!open && !removing) setPendingDelete(null);
        }}
        onConfirm={() => void remove()}
      />
    </>
  );
}

function statusLabel(document: DocumentRecord): string {
  switch (document.status) {
    case "pending":
      return "排队等待解析";
    case "processing":
      return "正在解析并分块";
    case "ready":
      return `${document.chunkCount} 个检索块`;
    case "failed":
      return "索引失败（原件仍在 R2）";
  }
}

function formatBytes(value: number | null): string {
  if (value === null) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchAllDocuments(): Promise<DocumentRecord[]> {
  const pageSize = 200;
  const documents: DocumentRecord[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(
      `/chat/documents?limit=${pageSize}&offset=${offset}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { documents: DocumentRecord[] };
    documents.push(...body.documents);
    if (body.documents.length < pageSize) return documents;
  }
}
