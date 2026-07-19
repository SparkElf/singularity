import type {
  ContentDirectoryDocument,
  ContentDirectoryNotebook,
  SpaceRuntimePathParameters,
} from "@singularity/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/utils.ts";
import {
  contentDirectoryDocumentsQueryKey,
  getContentDirectoryDocuments,
  type ContentDirectoryPageIdentity,
} from "@/spaces/content-directory-api.ts";
import type { ContentSelection } from "@/spaces/content-selection.ts";

interface ContentDirectoryTreeProps {
  readonly generation: number;
  readonly identity: SpaceRuntimePathParameters;
  readonly notebooks: readonly ContentDirectoryNotebook[];
  readonly onNotebookLocked: (notebookId: string, generation: number) => void;
  readonly onPageError: (error: unknown, generation: number) => void;
  readonly onSelect: (document: ContentDirectoryDocument) => void;
  readonly selection: ContentSelection | null;
}

interface DocumentLevelProps {
  readonly depth: number;
  readonly expandedDocuments: ReadonlySet<string>;
  readonly generation: number;
  readonly identity: ContentDirectoryPageIdentity;
  readonly onNotebookLocked: (notebookId: string, generation: number) => void;
  readonly onPageError: (error: unknown, generation: number) => void;
  readonly onSelect: (document: ContentDirectoryDocument) => void;
  readonly onToggleDocument: (document: ContentDirectoryDocument) => void;
  readonly selection: ContentSelection | null;
}

interface DocumentPageProps extends DocumentLevelProps {
  readonly offset: number;
  readonly onNextOffset: (offset: number) => void;
}

function DirectoryIcon({ icon }: { readonly icon: string }) {
  return icon === "" ? (
    <FileTextIcon aria-hidden="true" className="size-3.5 shrink-0" />
  ) : (
    <span aria-hidden="true" className="w-3.5 shrink-0 overflow-hidden text-center text-xs">
      {icon}
    </span>
  );
}

function DocumentPage({
  depth,
  expandedDocuments,
  generation,
  identity,
  offset,
  onNextOffset,
  onNotebookLocked,
  onPageError,
  onSelect,
  onToggleDocument,
  selection,
}: DocumentPageProps) {
  const pageQuery = useQuery({
    queryKey: contentDirectoryDocumentsQueryKey(identity, offset),
    queryFn: ({ signal }) =>
      getContentDirectoryDocuments(identity, offset, signal),
    refetchOnMount: false,
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (pageQuery.error) {
      onPageError(pageQuery.error, generation);
    }
  }, [generation, onPageError, pageQuery.error]);

  useEffect(() => {
    if (pageQuery.data?.locked) {
      onNotebookLocked(identity.notebookId, generation);
    }
  }, [generation, identity.notebookId, onNotebookLocked, pageQuery.data?.locked]);

  if (pageQuery.isPending) {
    return (
      <li aria-label="正在加载文档" className="space-y-1 px-2 py-1.5">
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-5 w-3/5" />
      </li>
    );
  }

  if (pageQuery.isError) {
    return (
      <li className="flex items-center gap-1 px-2 py-1.5 text-xs text-destructive">
        <span className="min-w-0 flex-1 truncate">该层未能加载</span>
        <Button
          aria-label="重新加载该层文档"
          onClick={() => void pageQuery.refetch()}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCwIcon aria-hidden="true" />
        </Button>
      </li>
    );
  }

  if (pageQuery.data.locked) {
    return (
      <li className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground max-md:h-11">
        <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
        <span>内容库已锁定</span>
      </li>
    );
  }

  if (pageQuery.data.documents.length === 0 && offset === 0) {
    return (
      <li className="flex h-7 items-center px-2 text-xs text-muted-foreground max-md:h-11">
        暂无文档
      </li>
    );
  }

  const nextOffset = pageQuery.data.nextOffset;
  return (
    <>
      {pageQuery.data.documents.map((document) => {
        const key = `${document.notebookId}:${document.documentId}`;
        const expanded = expandedDocuments.has(key);
        const selected =
          selection?.spaceId === identity.spaceId &&
          selection.notebookId === document.notebookId &&
          selection.documentId === document.documentId;
        const paddingInlineStart = `${Math.min(depth, 6) * 12 + 4}px`;
        return (
          <li key={key}>
            <div
              className={cn(
                "flex h-7 min-w-0 items-center rounded-md pr-1 text-xs hover:bg-sidebar-accent max-md:h-11",
                selected && "bg-accent text-accent-foreground",
              )}
              style={{ paddingInlineStart }}
            >
              {document.hasChildren ? (
                <Button
                  aria-label={expanded ? "折叠子文档" : "展开子文档"}
                  aria-expanded={expanded}
                  className="shrink-0"
                  onClick={() => onToggleDocument(document)}
                  size="icon-xs"
                  variant="ghost"
                >
                  {expanded ? (
                    <ChevronDownIcon aria-hidden="true" />
                  ) : (
                    <ChevronRightIcon aria-hidden="true" />
                  )}
                </Button>
              ) : (
                <span aria-hidden="true" className="size-6 shrink-0 max-md:size-10" />
              )}
              <button
                aria-current={selected ? "page" : undefined}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => onSelect(document)}
                type="button"
              >
                <DirectoryIcon icon={document.icon} />
                <span className="truncate" title={document.title || "无标题"}>
                  {document.title || "无标题"}
                </span>
              </button>
            </div>
            {expanded ? (
              <DocumentLevel
                depth={depth + 1}
                expandedDocuments={expandedDocuments}
                generation={generation}
                identity={{
                  level: {
                    kind: "children",
                    parentDocumentId: document.documentId,
                  },
                  notebookId: document.notebookId,
                  organizationId: identity.organizationId,
                  spaceId: identity.spaceId,
                }}
                onNotebookLocked={onNotebookLocked}
                onPageError={onPageError}
                onSelect={onSelect}
                onToggleDocument={onToggleDocument}
                selection={selection}
              />
            ) : null}
          </li>
        );
      })}
      {nextOffset === null ? null : (
        <li style={{ paddingInlineStart: `${Math.min(depth, 6) * 12 + 28}px` }}>
          <Button
            className="justify-start text-xs"
            onClick={() => onNextOffset(nextOffset)}
            size="xs"
            variant="ghost"
          >
            <ChevronDownIcon aria-hidden="true" />
            加载更多
          </Button>
        </li>
      )}
    </>
  );
}

function DocumentLevel(props: DocumentLevelProps) {
  const [offsets, setOffsets] = useState<readonly number[]>([0]);

  return (
    <ul>
      {offsets.map((offset) => (
        <DocumentPage
          {...props}
          key={offset}
          offset={offset}
          onNextOffset={(nextOffset) => {
            setOffsets((current) =>
              current.includes(nextOffset)
                ? current
                : [...current, nextOffset],
            );
          }}
        />
      ))}
    </ul>
  );
}

export function ContentDirectoryTree({
  generation,
  identity,
  notebooks,
  onNotebookLocked,
  onPageError,
  onSelect,
  selection,
}: ContentDirectoryTreeProps) {
  const [expandedDocuments, setExpandedDocuments] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedNotebooks, setExpandedNotebooks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (selection?.spaceId !== identity.spaceId) {
      return;
    }
    setExpandedNotebooks((current) => {
      if (current.has(selection.notebookId)) {
        return current;
      }
      const next = new Set(current);
      next.add(selection.notebookId);
      return next;
    });
  }, [identity.spaceId, selection]);

  return (
    <nav aria-label="文档目录" className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      <ul>
        {notebooks.map((notebook) => {
          const expanded = expandedNotebooks.has(notebook.notebookId);
          return (
            <li key={notebook.notebookId}>
              <div className="flex h-8 min-w-0 items-center rounded-md px-1 text-xs font-medium hover:bg-sidebar-accent max-md:h-11">
                {notebook.locked ? (
                  <span className="flex size-6 shrink-0 items-center justify-center max-md:size-10">
                    <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
                  </span>
                ) : (
                  <Button
                    aria-label={expanded ? "折叠笔记本" : "展开笔记本"}
                    aria-expanded={expanded}
                    className="shrink-0"
                    onClick={() => {
                      setExpandedNotebooks((current) => {
                        const next = new Set(current);
                        if (next.has(notebook.notebookId)) {
                          next.delete(notebook.notebookId);
                        } else {
                          next.add(notebook.notebookId);
                        }
                        return next;
                      });
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    {expanded ? (
                      <ChevronDownIcon aria-hidden="true" />
                    ) : (
                      <ChevronRightIcon aria-hidden="true" />
                    )}
                  </Button>
                )}
                <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
                  {notebook.icon === "" ? (
                    <BookOpenIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : (
                    <span aria-hidden="true" className="w-3.5 shrink-0 overflow-hidden text-center text-xs">
                      {notebook.icon}
                    </span>
                  )}
                  <span className="truncate" title={notebook.name}>
                    {notebook.name}
                  </span>
                </span>
              </div>
              {!notebook.locked && expanded ? (
                <DocumentLevel
                  depth={1}
                  expandedDocuments={expandedDocuments}
                  generation={generation}
                  identity={{
                    level: { kind: "root" },
                    notebookId: notebook.notebookId,
                    organizationId: identity.organizationId,
                    spaceId: identity.spaceId,
                  }}
                  onNotebookLocked={onNotebookLocked}
                  onPageError={onPageError}
                  onSelect={onSelect}
                  onToggleDocument={(document) => {
                    const key = `${document.notebookId}:${document.documentId}`;
                    setExpandedDocuments((current) => {
                      const next = new Set(current);
                      if (next.has(key)) {
                        next.delete(key);
                      } else {
                        next.add(key);
                      }
                      return next;
                    });
                  }}
                  selection={selection}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
