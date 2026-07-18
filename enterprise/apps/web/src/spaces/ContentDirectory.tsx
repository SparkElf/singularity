import type {
  ContentDirectoryDocument,
  SpaceRuntimePathParameters,
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
  contentDirectoryDocumentsQueryKey,
  contentDirectoryNotebooksQueryKey,
  contentDirectorySpaceQueryKey,
  getContentDirectoryDocuments,
  getContentDirectoryNotebooks,
} from "@/spaces/content-directory-api.ts";
import { ContentDirectoryTree } from "@/spaces/ContentDirectoryTree.tsx";
import { useContentSelectionStore } from "@/spaces/content-selection.ts";

export type ContentDirectoryStatus = "empty" | "error" | "loading" | "ready";
export type ContentDirectoryAccessLoss = "forbidden" | "unauthenticated";

interface ContentDirectoryProps {
  readonly identity: SpaceRuntimePathParameters;
  readonly onAccessLost: (category: ContentDirectoryAccessLoss) => void;
  readonly onStatusChange: (status: ContentDirectoryStatus) => void;
}

function currentSelectionForSpace(spaceId: string) {
  const selection = useContentSelectionStore.getState().selection;
  return selection?.spaceId === spaceId ? selection : null;
}

export function ContentDirectory({
  identity,
  onAccessLost,
  onStatusChange,
}: ContentDirectoryProps) {
  const queryClient = useQueryClient();
  const clearSelection = useContentSelectionStore((state) => state.clearSelection);
  const selectDocument = useContentSelectionStore((state) => state.selectDocument);
  const selection = useContentSelectionStore((state) =>
    state.selection?.spaceId === identity.spaceId ? state.selection : null,
  );
  const generationRef = useRef(0);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<ContentDirectoryStatus>("loading");
  const notebooksQuery = useQuery({
    queryKey: contentDirectoryNotebooksQueryKey(identity),
    queryFn: ({ signal }) => getContentDirectoryNotebooks(identity, signal),
    refetchOnMount: "always",
    retry: false,
    staleTime: 0,
  });
  const hasCurrentNotebooks =
    notebooksQuery.isSuccess &&
    notebooksQuery.isFetchedAfterMount &&
    !notebooksQuery.isFetching &&
    !notebooksQuery.isPaused;
  const notebooks = hasCurrentNotebooks ? notebooksQuery.data.notebooks : [];

  useEffect(() => {
    onStatusChange(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    const routeGeneration = ++generationRef.current;
    setGeneration(routeGeneration);
    setStatus("loading");
    clearSelection();
    console.info("[content.directory]", {
      generation: routeGeneration,
      phase: "route",
      result: "activated",
      spaceId: identity.spaceId,
    });

    return () => {
      ++generationRef.current;
      const current = currentSelectionForSpace(identity.spaceId);
      if (current !== null) {
        useContentSelectionStore.getState().clearSelection();
      }
      void queryClient.cancelQueries({
        queryKey: contentDirectorySpaceQueryKey(identity),
      });
      console.info("[content.directory]", {
        generation: routeGeneration,
        phase: "route",
        result: "released",
        spaceId: identity.spaceId,
      });
    };
  }, [clearSelection, identity.organizationId, identity.spaceId, queryClient]);

  const handleAccessError = useCallback((error: unknown) => {
    if (isApiProblem(error, "unauthenticated")) {
      clearSelection();
      setStatus("loading");
      onAccessLost("unauthenticated");
      return true;
    }
    if (isApiProblem(error, "not-found")) {
      clearSelection();
      setStatus("loading");
      onAccessLost("forbidden");
      return true;
    }
    return false;
  }, [clearSelection, onAccessLost]);

  useEffect(() => {
    if (!notebooksQuery.error || handleAccessError(notebooksQuery.error)) {
      return;
    }
    setStatus("error");
    console.warn("[content.directory]", {
      generation: generationRef.current,
      phase: "notebooks",
      result: "failed",
      spaceId: identity.spaceId,
    });
  }, [handleAccessError, identity.spaceId, notebooksQuery.error]);

  useEffect(() => {
    if (!hasCurrentNotebooks || generation === 0) {
      return;
    }
    const currentGeneration = generation;
    let cancelled = false;

    const selectFirstDocument = async () => {
      const current = currentSelectionForSpace(identity.spaceId);
      if (current !== null) {
        const notebook = notebooks.find(
          (candidate) => candidate.notebookId === current.notebookId,
        );
        if (notebook && !notebook.locked) {
          setStatus("ready");
          return;
        }
        clearSelection();
      }

      for (const notebook of notebooks) {
        if (notebook.locked) {
          continue;
        }
        const pageIdentity = {
          level: { kind: "root" as const },
          notebookId: notebook.notebookId,
          organizationId: identity.organizationId,
          spaceId: identity.spaceId,
        };
        let page;
        try {
          page = await queryClient.fetchQuery({
            queryKey: contentDirectoryDocumentsQueryKey(pageIdentity, 0),
            queryFn: ({ signal }) =>
              getContentDirectoryDocuments(pageIdentity, 0, signal),
            retry: false,
            staleTime: 0,
          });
        } catch (error) {
          if (cancelled || currentGeneration !== generationRef.current) {
            console.warn("[content.directory]", {
              generation: currentGeneration,
              notebookId: notebook.notebookId,
              phase: "bootstrap",
              result: "stale-result-rejected",
              spaceId: identity.spaceId,
            });
            return;
          }
          if (!handleAccessError(error)) {
            setStatus("error");
            console.warn("[content.directory]", {
              generation: currentGeneration,
              notebookId: notebook.notebookId,
              phase: "bootstrap",
              result: "failed",
              spaceId: identity.spaceId,
            });
          }
          return;
        }

        if (cancelled || currentGeneration !== generationRef.current) {
          console.warn("[content.directory]", {
            generation: currentGeneration,
            notebookId: notebook.notebookId,
            phase: "bootstrap",
            result: "stale-result-rejected",
            spaceId: identity.spaceId,
          });
          return;
        }
        const selectedByUser = currentSelectionForSpace(identity.spaceId);
        if (selectedByUser !== null) {
          setStatus("ready");
          return;
        }
        if (page.locked) {
          continue;
        }
        const firstDocument = page.documents[0];
        if (firstDocument) {
          selectDocument({
            documentId: firstDocument.documentId,
            notebookId: firstDocument.notebookId,
            spaceId: identity.spaceId,
          });
          setStatus("ready");
          console.info("[content.directory]", {
            documentId: firstDocument.documentId,
            generation: currentGeneration,
            notebookId: firstDocument.notebookId,
            phase: "bootstrap",
            result: "selected",
            spaceId: identity.spaceId,
          });
          return;
        }
      }

      setStatus("empty");
      console.info("[content.directory]", {
        generation: currentGeneration,
        phase: "bootstrap",
        result: "empty",
        spaceId: identity.spaceId,
      });
    };

    void selectFirstDocument();
    return () => {
      cancelled = true;
    };
  }, [
    bootstrapAttempt,
    clearSelection,
    generation,
    handleAccessError,
    hasCurrentNotebooks,
    identity.organizationId,
    identity.spaceId,
    notebooks,
    queryClient,
    selectDocument,
  ]);

  const restart = useCallback(() => {
    const nextGeneration = ++generationRef.current;
    setGeneration(nextGeneration);
    setStatus("loading");
    clearSelection();
    void queryClient.cancelQueries({
      queryKey: contentDirectorySpaceQueryKey(identity),
    }).then(() => queryClient.invalidateQueries({
      queryKey: contentDirectorySpaceQueryKey(identity),
    })).finally(() => {
      if (generationRef.current === nextGeneration) {
        setBootstrapAttempt((current) => current + 1);
      }
    });
  }, [clearSelection, identity, queryClient]);

  const commitSelection = useCallback((document: ContentDirectoryDocument) => {
    selectDocument({
      documentId: document.documentId,
      notebookId: document.notebookId,
      spaceId: identity.spaceId,
    });
    setStatus("ready");
    console.info("[content.directory]", {
      documentId: document.documentId,
      generation: generationRef.current,
      notebookId: document.notebookId,
      phase: "selection",
      result: "selected",
      spaceId: identity.spaceId,
    });
  }, [identity.spaceId, selectDocument]);

  const handleNotebookLocked = useCallback((notebookId: string) => {
    const current = currentSelectionForSpace(identity.spaceId);
    if (current?.notebookId !== notebookId) {
      return;
    }
    clearSelection();
    setStatus("empty");
    console.warn("[content.directory]", {
      generation: generationRef.current,
      notebookId,
      phase: "selection",
      result: "locked-selection-cleared",
      spaceId: identity.spaceId,
    });
  }, [clearSelection, identity.spaceId]);

  const handlePageError = useCallback((error: unknown) => {
    handleAccessError(error);
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
          disabled={status === "loading"}
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
          key={generation}
          identity={identity}
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
