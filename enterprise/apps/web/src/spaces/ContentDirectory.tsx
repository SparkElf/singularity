import type {
  ContentDirectoryDocument,
  ContentDirectoryDocumentsResponse,
  ContentDirectoryNotebooksResponse,
  SpaceRuntimePathParameters,
} from "@singularity/contracts";
import type { ProtyleRuntimeErrorEvent } from "@singularity/protyle-browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  CircleOffIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  isApiProblem,
  isRuntimeAccessLostProblem,
} from "@/api/http.ts";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  type ContentSelection,
  type ContentSelectionTarget,
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
export type ContentDirectoryAccessLoss = Omit<
  ProtyleRuntimeErrorEvent,
  "category"
> & {
  readonly category: "forbidden" | "unauthenticated";
};

export interface ContentDirectoryIdentity extends SpaceRuntimePathParameters {
  readonly generation: number;
}

interface ContentDirectoryProps {
  readonly identity: ContentDirectoryIdentity;
  readonly onClear: () => boolean;
  readonly onAccessLost: (event: ContentDirectoryAccessLoss) => void;
  readonly onSelect: (target: ContentSelectionTarget) => boolean;
  readonly onStatusChange: (status: ContentDirectoryStatus) => void;
  readonly selection: ContentSelection | null;
}

export function ContentDirectory({
  identity,
  onClear,
  onAccessLost,
  onSelect,
  onStatusChange,
  selection: ownerSelection,
}: ContentDirectoryProps) {
  const queryClient = useQueryClient();
  const selection = ownerSelection?.spaceId === identity.spaceId
    ? ownerSelection
    : null;
  const selectionRef = useRef(selection);
  const onClearRef = useRef(onClear);
  const onSelectRef = useRef(onSelect);
  const requestGenerationRef = useRef(0);
  const accessLossGenerationRef = useRef<number | null>(null);
  const notebookLockStateRef = useRef<Map<string, boolean> | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const settledGenerationRef = useRef<number | null>(null);
  const [requestGeneration, setRequestGeneration] = useState(0);
  const [treeGeneration, setTreeGeneration] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<ContentDirectoryStatus>("loading");
  const notebooksQuery = useQuery({
    queryKey: contentDirectoryNotebooksQueryKey(identity),
    queryFn: ({ signal }) => getContentDirectoryNotebooks(identity, signal),
    refetchOnMount: "always",
    retry: false,
    staleTime: 0,
  });
  const hasLoadedNotebooks =
    notebooksQuery.data !== undefined &&
    notebooksQuery.isFetchedAfterMount;
  const canCommitNotebooks =
    hasLoadedNotebooks &&
    notebooksQuery.isSuccess &&
    !notebooksQuery.isFetching &&
    !notebooksQuery.isPaused &&
    !refreshing;
  const notebooks = useMemo(
    () => hasLoadedNotebooks ? notebooksQuery.data.notebooks : [],
    [hasLoadedNotebooks, notebooksQuery.data],
  );

  useEffect(() => {
    selectionRef.current = selection;
    onClearRef.current = onClear;
    onSelectRef.current = onSelect;
  }, [onClear, onSelect, selection]);

  useEffect(() => {
    onStatusChange(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    const routeGeneration = ++requestGenerationRef.current;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    accessLossGenerationRef.current = null;
    notebookLockStateRef.current = null;
    settledGenerationRef.current = null;
    setRequestGeneration(routeGeneration);
    setTreeGeneration(routeGeneration);
    setRefreshing(false);
    setStatus("loading");
    if (onClearRef.current()) {
      selectionRef.current = null;
    }
    console.info("[content.directory]", {
      generation: identity.generation,
      phase: "route",
      result: "activated",
      spaceId: identity.spaceId,
    });

    return () => {
      // 释放当前路由代次，清理动作必须读取最新计数以拒绝迟到响应。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++requestGenerationRef.current;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      void queryClient.cancelQueries({
        queryKey: contentDirectorySpaceQueryKey(identity),
      }).catch((error: unknown) => {
        console.warn("[content.directory]", {
          error,
          generation: identity.generation,
          phase: "route",
          result: "request-cleanup-failed",
          spaceId: identity.spaceId,
        });
      });
      console.info("[content.directory]", {
        generation: identity.generation,
        phase: "route",
        result: "released",
        spaceId: identity.spaceId,
      });
    };
  }, [
    identity,
    queryClient,
  ]);

  const handleAccessError = useCallback((
    error: unknown,
    expectedGeneration = requestGenerationRef.current,
  ) => {
    const currentGeneration = requestGenerationRef.current;
    if (expectedGeneration !== currentGeneration) {
      console.warn("[content.directory]", {
        error,
        generation: identity.generation,
        phase: "access",
        result: "stale-generation-rejected",
        spaceId: identity.spaceId,
      });
      return true;
    }
    if (accessLossGenerationRef.current === currentGeneration) {
      return true;
    }
    let accessLoss: ContentDirectoryAccessLoss | null = null;
    if (isApiProblem(error, "unauthenticated")) {
      accessLoss = {
        category: "unauthenticated",
        triggeringRequestId: error.problem.requestId,
        type: "runtime-error",
      };
    } else if (isRuntimeAccessLostProblem(error)) {
      accessLoss = {
        category: "forbidden",
        triggeringRequestId: error.problem.requestId,
        type: "runtime-error",
      };
    }
    if (accessLoss === null) {
      return false;
    }
    console.warn("[content.directory]", {
      category: accessLoss.category,
      error,
      generation: identity.generation,
      phase: "access",
      result: "lost",
      spaceId: identity.spaceId,
      ...(accessLoss.triggeringRequestId
        ? { triggeringRequestId: accessLoss.triggeringRequestId }
        : {}),
    });
    accessLossGenerationRef.current = ++requestGenerationRef.current;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    setRefreshing(false);
    setStatus("loading");
    onAccessLost(accessLoss);
    return true;
  }, [identity.generation, identity.spaceId, onAccessLost]);

  useEffect(() => {
    // 查询错误需要在同一 effect 内切换状态，并由统一 access owner 处理授权失效。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!notebooksQuery.error || refreshing || handleAccessError(notebooksQuery.error)) {
      return;
    }
    // 查询失败后立即将目录状态交给上层，避免继续渲染过期内容。
    setStatus("error");
    console.warn("[content.directory]", {
      error: notebooksQuery.error,
      generation: identity.generation,
      phase: "notebooks",
      result: "failed",
      spaceId: identity.spaceId,
    });
  }, [
    handleAccessError,
    identity.generation,
    identity.spaceId,
    notebooksQuery.error,
    refreshing,
  ]);

  const quarantineNotebooks = useCallback((
    notebookIds: readonly string[],
    expectedGeneration: number,
  ) => {
    const affectedNotebookIds = [...new Set(notebookIds)];
    if (
      affectedNotebookIds.length === 0 ||
      expectedGeneration !== requestGenerationRef.current
    ) {
      return;
    }
    const nextGeneration = ++requestGenerationRef.current;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    settledGenerationRef.current = null;
    setRequestGeneration(nextGeneration);
    setTreeGeneration(nextGeneration);
    setRefreshing(false);
    const current = selectionRef.current;
    const affected = new Set(affectedNotebookIds);
    const authoritativeLockState = notebookLockStateRef.current;
    queryClient.setQueryData<ContentDirectoryNotebooksResponse>(
      contentDirectoryNotebooksQueryKey(identity),
      (previous) => {
        if (!previous) {
          return previous;
        }
        return {
          notebooks: previous.notebooks.flatMap((candidate) => {
            if (!affected.has(candidate.notebookId)) {
              return [candidate];
            }
            if (
              authoritativeLockState !== null &&
              !authoritativeLockState.has(candidate.notebookId)
            ) {
              return [];
            }
            return candidate.locked
              ? [candidate]
              : [{ ...candidate, locked: true }];
          }),
        };
      },
    );
    for (const notebookId of affectedNotebookIds) {
      const notebookPagesKey = [
        ...contentDirectorySpaceQueryKey(identity),
        "documents",
        notebookId,
      ] as const;
      void queryClient.cancelQueries({ queryKey: notebookPagesKey }).catch(
        (error: unknown) => {
          console.warn("[content.directory]", {
            error,
            generation: identity.generation,
            notebookId,
            phase: "lock",
            result: "page-cancellation-failed",
            spaceId: identity.spaceId,
          });
        },
      );
      queryClient.removeQueries({ queryKey: notebookPagesKey });
    }
    if (
      current !== null &&
      affected.has(current.notebookId) &&
      onClearRef.current()
    ) {
      selectionRef.current = null;
      setStatus("empty");
    }
    for (const notebookId of affectedNotebookIds) {
      console.warn("[content.directory]", {
        generation: identity.generation,
        notebookId,
        phase: "lock",
        result: "notebook-quarantined",
        spaceId: identity.spaceId,
      });
    }
  }, [identity, queryClient]);

  const handleNotebookLocked = useCallback((
    notebookId: string,
    expectedGeneration: number,
  ) => {
    if (expectedGeneration !== requestGenerationRef.current) {
      return;
    }
    const nextLockState = new Map(notebookLockStateRef.current ?? []);
    nextLockState.set(notebookId, true);
    notebookLockStateRef.current = nextLockState;
    quarantineNotebooks([notebookId], expectedGeneration);
  }, [quarantineNotebooks]);

  useLayoutEffect(() => {
    if (!hasLoadedNotebooks) {
      return;
    }
    const previous = notebookLockStateRef.current;
    const current = new Map(
      notebooks.map((notebook) => [notebook.notebookId, notebook.locked]),
    );
    notebookLockStateRef.current = current;
    const affected = new Set<string>();
    if (previous === null) {
      for (const notebook of notebooks) {
        if (notebook.locked) {
          affected.add(notebook.notebookId);
        }
      }
    } else {
      for (const [notebookId, wasLocked] of previous) {
        if (!wasLocked && (!current.has(notebookId) || current.get(notebookId))) {
          affected.add(notebookId);
        }
      }
      for (const [notebookId, locked] of current) {
        if (locked && previous.get(notebookId) !== true) {
          affected.add(notebookId);
        }
      }
    }
    quarantineNotebooks([...affected], requestGenerationRef.current);
    const currentSelection = selectionRef.current;
    if (currentSelection === null || affected.has(currentSelection.notebookId)) {
      return;
    }
    const selectedNotebook = notebooks.find(
      (notebook) => notebook.notebookId === currentSelection.notebookId,
    );
    if (
      !selectedNotebook ||
      selectedNotebook.locked ||
      selectedNotebook.supportsGraph === currentSelection.supportsGraph
    ) {
      return;
    }
    const target = {
      documentId: currentSelection.documentId,
      notebookId: currentSelection.notebookId,
      supportsGraph: selectedNotebook.supportsGraph,
    } satisfies ContentSelectionTarget;
    if (onSelectRef.current(target)) {
      selectionRef.current = {
        ...target,
        spaceId: currentSelection.spaceId,
      };
    }
  }, [hasLoadedNotebooks, notebooks, quarantineNotebooks]);

  useEffect(() => {
    if (!canCommitNotebooks || requestGeneration === 0) {
      return;
    }
    const currentGeneration = requestGeneration;
    if (settledGenerationRef.current === currentGeneration) {
      return;
    }
    let cancelled = false;

    const selectFirstDocument = async () => {
      const current = selectionRef.current;
      let expectedSelection = current;
      if (current !== null) {
        const notebook = notebooks.find(
          (candidate) => candidate.notebookId === current.notebookId,
        );
        if (notebook && !notebook.locked) {
          if (current.supportsGraph !== notebook.supportsGraph) {
            const target = {
              documentId: current.documentId,
              notebookId: current.notebookId,
              supportsGraph: notebook.supportsGraph,
            } satisfies ContentSelectionTarget;
            if (!onSelectRef.current(target)) {
              return;
            }
            selectionRef.current = {
              ...target,
              spaceId: identity.spaceId,
            };
          }
          settledGenerationRef.current = currentGeneration;
          setStatus("ready");
          return;
        }
        if (onClearRef.current()) {
          selectionRef.current = null;
          expectedSelection = null;
        }
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
              error,
              generation: identity.generation,
              notebookId: notebook.notebookId,
              phase: "bootstrap",
              result: "stale-result-rejected",
              spaceId: identity.spaceId,
            });
            return;
          }
          if (!handleAccessError(error)) {
            settledGenerationRef.current = currentGeneration;
            setStatus("error");
            console.warn("[content.directory]", {
              error,
              generation: identity.generation,
              notebookId: notebook.notebookId,
              phase: "bootstrap",
              result: "failed",
              spaceId: identity.spaceId,
            });
          }
          return;
        }

        if (cancelled || currentGeneration !== requestGenerationRef.current) {
          console.warn("[content.directory]", {
            generation: identity.generation,
            notebookId: notebook.notebookId,
            phase: "bootstrap",
            result: "stale-result-rejected",
            spaceId: identity.spaceId,
          });
          return;
        }
        const selectedByUser = selectionRef.current;
        if (selectedByUser !== expectedSelection) {
          settledGenerationRef.current = currentGeneration;
          setStatus("ready");
          return;
        }
        if (page.locked) {
          handleNotebookLocked(notebook.notebookId, currentGeneration);
          return;
        }
        const firstDocument = page.documents[0];
        if (firstDocument) {
          const target = {
            documentId: firstDocument.documentId,
            notebookId: firstDocument.notebookId,
            supportsGraph: notebook.supportsGraph,
          } satisfies ContentSelectionTarget;
          if (!onSelectRef.current(target)) {
            return;
          }
          selectionRef.current = {
            ...target,
            spaceId: identity.spaceId,
          };
          settledGenerationRef.current = currentGeneration;
          setStatus("ready");
          console.info("[content.directory]", {
            documentId: firstDocument.documentId,
            generation: identity.generation,
            notebookId: firstDocument.notebookId,
            phase: "bootstrap",
            result: "selected",
            spaceId: identity.spaceId,
          });
          return;
        }
      }

      if (!cancelled && currentGeneration === requestGenerationRef.current) {
        settledGenerationRef.current = currentGeneration;
        setStatus("empty");
        console.info("[content.directory]", {
          generation: identity.generation,
          phase: "bootstrap",
          result: "empty",
          spaceId: identity.spaceId,
        });
      }
    };

    void selectFirstDocument();
    return () => {
      cancelled = true;
    };
  }, [
    handleAccessError,
    canCommitNotebooks,
    notebooks,
    queryClient,
    handleNotebookLocked,
    requestGeneration,
    identity.generation,
    identity.organizationId,
    identity.spaceId,
  ]);

  const restart = useCallback(() => {
    const nextGeneration = ++requestGenerationRef.current;
    const expectedSelection = selectionRef.current;
    const refreshController = new AbortController();
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = refreshController;
    accessLossGenerationRef.current = null;
    settledGenerationRef.current = null;
    setRequestGeneration(nextGeneration);
    if (!hasLoadedNotebooks) {
      setStatus("loading");
    }
    setRefreshing(true);
    void (async () => {
      await queryClient.cancelQueries({
        queryKey: contentDirectorySpaceQueryKey(identity),
      });
      if (requestGenerationRef.current !== nextGeneration) {
        return;
      }

      const nextNotebooks = await getContentDirectoryNotebooks(
        identity,
        refreshController.signal,
      );
      if (requestGenerationRef.current !== nextGeneration) {
        return;
      }
      const previousLockState = notebookLockStateRef.current ?? new Map(
        notebooks.map((notebook) => [notebook.notebookId, notebook.locked]),
      );
      const nextLockState = new Map(
        nextNotebooks.notebooks.map((notebook) => [
          notebook.notebookId,
          notebook.locked,
        ]),
      );
      const affected = new Set<string>();
      for (const [notebookId, wasLocked] of previousLockState) {
        if (
          !wasLocked &&
          (!nextLockState.has(notebookId) || nextLockState.get(notebookId))
        ) {
          affected.add(notebookId);
        }
      }
      for (const [notebookId, locked] of nextLockState) {
        if (locked && previousLockState.get(notebookId) !== true) {
          affected.add(notebookId);
        }
      }
      if (affected.size > 0) {
        notebookLockStateRef.current = nextLockState;
        quarantineNotebooks([...affected], nextGeneration);
        return;
      }

      const freshRootPages = new Map<
        string,
        ContentDirectoryDocumentsResponse
      >();
      let firstSelection: ContentSelectionTarget | null = null;
      for (const notebook of nextNotebooks.notebooks) {
        if (notebook.locked) {
          continue;
        }
        const pageIdentity = {
          level: { kind: "root" as const },
          notebookId: notebook.notebookId,
          organizationId: identity.organizationId,
          spaceId: identity.spaceId,
        };
        const page = await getContentDirectoryDocuments(
          pageIdentity,
          0,
          refreshController.signal,
        );
        if (requestGenerationRef.current !== nextGeneration) {
          return;
        }
        if (page.locked) {
          nextLockState.set(notebook.notebookId, true);
          notebookLockStateRef.current = nextLockState;
          quarantineNotebooks([notebook.notebookId], nextGeneration);
          return;
        }
        freshRootPages.set(notebook.notebookId, page);
        const firstDocument = page.documents[0];
        if (firstDocument) {
          firstSelection = {
            documentId: firstDocument.documentId,
            notebookId: firstDocument.notebookId,
            supportsGraph: notebook.supportsGraph,
          };
          break;
        }
      }

      if (requestGenerationRef.current !== nextGeneration) {
        return;
      }
      queryClient.removeQueries({
        queryKey: [...contentDirectorySpaceQueryKey(identity), "documents"],
      });
      for (const [notebookId, page] of freshRootPages) {
        queryClient.setQueryData(
          contentDirectoryDocumentsQueryKey({
            level: { kind: "root" },
            notebookId,
            organizationId: identity.organizationId,
            spaceId: identity.spaceId,
          }, 0),
          page,
        );
      }
      notebookLockStateRef.current = nextLockState;
      queryClient.setQueryData(
        contentDirectoryNotebooksQueryKey(identity),
        nextNotebooks,
      );
      settledGenerationRef.current = nextGeneration;
      setTreeGeneration(nextGeneration);

      if (selectionRef.current !== expectedSelection) {
        setStatus(selectionRef.current === null ? "empty" : "ready");
        return;
      }
      if (firstSelection !== null) {
        if (!onSelectRef.current(firstSelection)) {
          return;
        }
        selectionRef.current = {
          ...firstSelection,
          spaceId: identity.spaceId,
        };
        setStatus("ready");
        return;
      }
      if (onClearRef.current()) {
        selectionRef.current = null;
      }
      setStatus("empty");
    })().catch((error: unknown) => {
      if (requestGenerationRef.current !== nextGeneration) {
        console.warn("[content.directory]", {
          error,
          generation: identity.generation,
          phase: "refresh",
          result: "stale-result-rejected",
          spaceId: identity.spaceId,
        });
        return;
      }
      if (!handleAccessError(error, nextGeneration)) {
        settledGenerationRef.current = nextGeneration;
        setStatus("error");
        console.warn("[content.directory]", {
          error,
          generation: identity.generation,
          phase: "refresh",
          result: "failed",
          spaceId: identity.spaceId,
        });
      }
    }).finally(() => {
      if (refreshControllerRef.current === refreshController) {
        refreshControllerRef.current = null;
      }
      if (requestGenerationRef.current === nextGeneration) {
        setRefreshing(false);
      }
    });
  }, [
    hasLoadedNotebooks,
    handleAccessError,
    identity,
    notebooks,
    quarantineNotebooks,
    queryClient,
  ]);

  const commitSelection = useCallback((
    document: ContentDirectoryDocument,
    supportsGraph: boolean,
    expectedGeneration: number,
  ) => {
    if (expectedGeneration !== requestGenerationRef.current) {
      console.warn("[content.directory]", {
        documentId: document.documentId,
        generation: identity.generation,
        notebookId: document.notebookId,
        phase: "selection",
        result: "stale-generation-rejected",
        spaceId: identity.spaceId,
      });
      return;
    }
    const target = {
      documentId: document.documentId,
      notebookId: document.notebookId,
      supportsGraph,
    } satisfies ContentSelectionTarget;
    if (!onSelectRef.current(target)) {
      return;
    }
    selectionRef.current = {
      ...target,
      spaceId: identity.spaceId,
    };
    settledGenerationRef.current = expectedGeneration;
    setStatus("ready");
    console.info("[content.directory]", {
      documentId: document.documentId,
      generation: identity.generation,
      notebookId: document.notebookId,
      phase: "selection",
      result: "selected",
      spaceId: identity.spaceId,
    });
  }, [identity.generation, identity.spaceId]);

  const handlePageError = useCallback((error: unknown, expectedGeneration: number) => {
    if (handleAccessError(error, expectedGeneration)) {
      return;
    }
    console.warn("[content.directory]", {
      error,
      generation: identity.generation,
      phase: "page",
      result: "failed",
      spaceId: identity.spaceId,
    });
  }, [handleAccessError, identity.generation, identity.spaceId]);

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

      {!hasLoadedNotebooks &&
      !notebooksQuery.isError ? (
        <div aria-label="正在加载文档目录" className="space-y-2 px-3 py-3">
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-6 w-3/5" />
          <Skeleton className="h-6 w-5/6" />
        </div>
      ) : null}

      {notebooksQuery.isError && !hasLoadedNotebooks ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <CircleOffIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">无法读取文档目录</p>
          <Button onClick={restart} size="sm" variant="outline">
            <RefreshCwIcon aria-hidden="true" />
            重新加载
          </Button>
        </div>
      ) : null}

      {hasLoadedNotebooks && notebooks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          暂无笔记本
        </div>
      ) : null}

      {hasLoadedNotebooks && notebooks.length > 0 ? (
        <ContentDirectoryTree
          // 成功刷新后重建树，清除旧代次的分页、展开和子文档状态。
          key={treeGeneration}
          generation={requestGeneration}
          identity={identity}
          notebooks={notebooks}
          onNotebookLocked={handleNotebookLocked}
          onPageError={handlePageError}
          onSelect={commitSelection}
          selection={selection}
        />
      ) : null}

      {status === "error" && hasLoadedNotebooks ? (
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
