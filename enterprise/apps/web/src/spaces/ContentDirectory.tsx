import type {
  ContentDirectoryDocument,
  ContentDirectoryDocumentsResponse,
} from "@singularity/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  CircleOffIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { isApiProblem } from "@/api/http.ts";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  clearContentSelection,
  getContentSelectionForScope,
  isContentSelectionScopeActive,
  selectContentDocument,
  useContentSelectionStore,
  type ContentSelectionScope,
} from "@/spaces/content-selection.ts";
import {
  contentDirectoryDocumentsQueryKey,
  contentDirectoryNotebooksQueryKey,
  contentDirectorySpaceQueryKey,
  getContentDirectoryDocuments,
  getContentDirectoryNotebooks,
} from "@/spaces/content-directory-api.ts";
import { ContentDirectoryTree } from "@/spaces/ContentDirectoryTree.tsx";

export type ContentDirectoryStatus = "empty" | "error" | "loading" | "ready";
export type ContentDirectoryAccessLoss = "forbidden" | "unauthenticated";

interface ContentDirectoryProps {
  readonly onAccessLost: (category: ContentDirectoryAccessLoss) => void;
  readonly onStatusChange: (status: ContentDirectoryStatus) => void;
  readonly scope: ContentSelectionScope;
}

export function ContentDirectory({
  onAccessLost,
  onStatusChange,
  scope,
}: ContentDirectoryProps) {
  const queryClient = useQueryClient();
  const storeSelection = useContentSelectionStore((state) => state.selection);
  const selection = isContentSelectionScopeActive(scope) &&
    storeSelection?.spaceId === scope.spaceId
    ? storeSelection
    : null;
  const requestGenerationRef = useRef(0);
  const accessLossGenerationRef = useRef<number | null>(null);
  const [requestGeneration, setRequestGeneration] = useState(0);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<ContentDirectoryStatus>("loading");
  const notebooksQuery = useQuery({
    queryKey: contentDirectoryNotebooksQueryKey(scope),
    queryFn: ({ signal }) => getContentDirectoryNotebooks(scope, signal),
    refetchOnMount: "always",
    retry: false,
    staleTime: 0,
  });
  const hasCurrentNotebooks =
    !refreshing &&
    notebooksQuery.isSuccess &&
    notebooksQuery.isFetchedAfterMount &&
    !notebooksQuery.isFetching &&
    !notebooksQuery.isPaused;
  const notebooks = hasCurrentNotebooks ? notebooksQuery.data.notebooks : [];

  useEffect(() => {
    onStatusChange(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    const routeGeneration = ++requestGenerationRef.current;
    accessLossGenerationRef.current = null;
    setRequestGeneration(routeGeneration);
    setStatus("loading");
    clearContentSelection(scope);
    console.info("[content.directory]", {
      generation: scope.generation,
      phase: "route",
      result: "activated",
      spaceId: scope.spaceId,
    });

    return () => {
      ++requestGenerationRef.current;
      clearContentSelection(scope);
      void queryClient.cancelQueries({
        queryKey: contentDirectorySpaceQueryKey(scope),
      });
      console.info("[content.directory]", {
        generation: scope.generation,
        phase: "route",
        result: "released",
        spaceId: scope.spaceId,
      });
    };
  }, [queryClient, scope]);

  const handleAccessError = useCallback((
    error: unknown,
    expectedGeneration = requestGenerationRef.current,
  ) => {
    const currentGeneration = requestGenerationRef.current;
    if (expectedGeneration !== currentGeneration) {
      return true;
    }
    if (accessLossGenerationRef.current === currentGeneration) {
      return true;
    }
    if (isApiProblem(error, "unauthenticated")) {
      accessLossGenerationRef.current = currentGeneration;
      clearContentSelection(scope);
      setStatus("loading");
      onAccessLost("unauthenticated");
      return true;
    }
    if (isApiProblem(error, "not-found")) {
      accessLossGenerationRef.current = currentGeneration;
      clearContentSelection(scope);
      setStatus("loading");
      onAccessLost("forbidden");
      return true;
    }
    return false;
  }, [onAccessLost, scope]);

  useEffect(() => {
    if (!notebooksQuery.error || refreshing || handleAccessError(notebooksQuery.error)) {
      return;
    }
    setStatus("error");
    console.warn("[content.directory]", {
      generation: scope.generation,
      phase: "notebooks",
      result: "failed",
      spaceId: scope.spaceId,
    });
  }, [handleAccessError, notebooksQuery.error, refreshing, scope]);

  useEffect(() => {
    if (!hasCurrentNotebooks || requestGeneration === 0) {
      return;
    }
    const currentGeneration = requestGeneration;
    let cancelled = false;

    const selectFirstDocument = async () => {
      const current = getContentSelectionForScope(scope);
      if (current !== null) {
        const notebook = notebooks.find(
          (candidate) => candidate.notebookId === current.notebookId,
        );
        if (notebook && !notebook.locked) {
          setStatus("ready");
          return;
        }
        clearContentSelection(scope);
      }

      for (const notebook of notebooks) {
        if (notebook.locked) {
          continue;
        }
        const pageIdentity = {
          level: { kind: "root" as const },
          notebookId: notebook.notebookId,
          organizationId: scope.organizationId,
          spaceId: scope.spaceId,
        };
        let page: ContentDirectoryDocumentsResponse;
        try {
          page = await queryClient.fetchQuery({
            queryKey: contentDirectoryDocumentsQueryKey(pageIdentity, 0),
            queryFn: ({ signal }) =>
              getContentDirectoryDocuments(pageIdentity, 0, signal),
            retry: false,
            staleTime: 0,
          });
        } catch (error) {
          if (cancelled || currentGeneration !== requestGenerationRef.current) {
            console.warn("[content.directory]", {
              generation: scope.generation,
              notebookId: notebook.notebookId,
              phase: "bootstrap",
              result: "stale-result-rejected",
              spaceId: scope.spaceId,
            });
            return;
          }
          if (!handleAccessError(error)) {
            setStatus("error");
            console.warn("[content.directory]", {
              generation: scope.generation,
              notebookId: notebook.notebookId,
              phase: "bootstrap",
              result: "failed",
              spaceId: scope.spaceId,
            });
          }
          return;
        }

        if (cancelled || currentGeneration !== requestGenerationRef.current ||
          !isContentSelectionScopeActive(scope)) {
          console.warn("[content.directory]", {
            generation: scope.generation,
            notebookId: notebook.notebookId,
            phase: "bootstrap",
            result: "stale-result-rejected",
            spaceId: scope.spaceId,
          });
          return;
        }
        const selectedByUser = getContentSelectionForScope(scope);
        if (selectedByUser !== null) {
          setStatus("ready");
          return;
        }
        if (page.locked) {
          continue;
        }
        const firstDocument = page.documents[0];
        if (firstDocument) {
          selectContentDocument(scope, firstDocument);
          setStatus("ready");
          console.info("[content.directory]", {
            documentId: firstDocument.documentId,
            generation: scope.generation,
            notebookId: firstDocument.notebookId,
            phase: "bootstrap",
            result: "selected",
            spaceId: scope.spaceId,
          });
          return;
        }
      }

      if (!cancelled && currentGeneration === requestGenerationRef.current &&
        isContentSelectionScopeActive(scope)) {
        setStatus("empty");
        console.info("[content.directory]", {
          generation: scope.generation,
          phase: "bootstrap",
          result: "empty",
          spaceId: scope.spaceId,
        });
      }
    };

    void selectFirstDocument();
    return () => {
      cancelled = true;
    };
  }, [
    handleAccessError,
    hasCurrentNotebooks,
    notebooks,
    queryClient,
    refreshAttempt,
    requestGeneration,
    scope,
  ]);

  const restart = useCallback(() => {
    const nextGeneration = ++requestGenerationRef.current;
    accessLossGenerationRef.current = null;
    setRequestGeneration(nextGeneration);
    setStatus("loading");
    setRefreshing(true);
    clearContentSelection(scope);
    void queryClient.cancelQueries({
      queryKey: contentDirectorySpaceQueryKey(scope),
    }).then(async () => {
      if (requestGenerationRef.current !== nextGeneration) {
        return;
      }
      await queryClient.resetQueries({
        queryKey: contentDirectorySpaceQueryKey(scope),
      });
    }).catch((error: unknown) => {
      if (
        requestGenerationRef.current === nextGeneration &&
        !handleAccessError(error, nextGeneration)
      ) {
        setStatus("error");
        console.warn("[content.directory]", {
          generation: scope.generation,
          phase: "refresh",
          result: "failed",
          spaceId: scope.spaceId,
        });
      }
    }).finally(() => {
      if (requestGenerationRef.current === nextGeneration) {
        setRefreshing(false);
        setRefreshAttempt((current) => current + 1);
      }
    });
  }, [handleAccessError, queryClient, scope]);

  const commitSelection = useCallback((document: ContentDirectoryDocument) => {
    if (!selectContentDocument(scope, document)) {
      return;
    }
    setStatus("ready");
    console.info("[content.directory]", {
      documentId: document.documentId,
      generation: scope.generation,
      notebookId: document.notebookId,
      phase: "selection",
      result: "selected",
      spaceId: scope.spaceId,
    });
  }, [scope]);

  const handleNotebookLocked = useCallback((
    notebookId: string,
    expectedGeneration: number,
  ) => {
    if (expectedGeneration !== requestGenerationRef.current) {
      return;
    }
    const current = getContentSelectionForScope(scope);
    if (current?.notebookId !== notebookId) {
      return;
    }
    clearContentSelection(scope);
    setStatus("empty");
    console.warn("[content.directory]", {
      generation: scope.generation,
      notebookId,
      phase: "selection",
      result: "locked-selection-cleared",
      spaceId: scope.spaceId,
    });
  }, [scope]);

  const handlePageError = useCallback((error: unknown, expectedGeneration: number) => {
    handleAccessError(error, expectedGeneration);
  }, [handleAccessError]);

  return (
    <aside
      aria-busy={status === "loading"}
      className="flex min-h-0 w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground max-md:w-full"
      data-content-directory-status={status}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-2">
        <BookOpenIcon aria-hidden="true" className="size-3.5" />
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium">文档</h2>
        <Button
          aria-label="刷新文档目录"
          disabled={status === "loading" || refreshing}
          onClick={restart}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCwIcon aria-hidden="true" />
        </Button>
      </div>

      {(!hasCurrentNotebooks || status === "loading") &&
      !notebooksQuery.isError ? (
        <div aria-label="正在加载文档目录" className="space-y-2 px-3 py-3">
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-6 w-3/5" />
          <Skeleton className="h-6 w-5/6" />
        </div>
      ) : null}

      {notebooksQuery.isError && !hasCurrentNotebooks ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <CircleOffIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">无法读取文档目录</p>
          <Button onClick={restart} size="sm" variant="outline">
            <RefreshCwIcon aria-hidden="true" />
            重新加载
          </Button>
        </div>
      ) : null}

      {hasCurrentNotebooks && status !== "loading" && notebooks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          暂无笔记本
        </div>
      ) : null}

      {hasCurrentNotebooks && status !== "loading" && notebooks.length > 0 ? (
        <ContentDirectoryTree
          key={`${scope.generation}:${requestGeneration}`}
          generation={requestGeneration}
          identity={scope}
          notebooks={notebooks}
          onNotebookLocked={handleNotebookLocked}
          onPageError={handlePageError}
          onSelect={commitSelection}
          selection={selection}
        />
      ) : null}

      {status === "error" && hasCurrentNotebooks ? (
        <div className="border-t border-sidebar-border p-2">
          <Button className="w-full" onClick={restart} size="sm" variant="outline">
            <RefreshCwIcon aria-hidden="true" />
            重新加载目录
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
