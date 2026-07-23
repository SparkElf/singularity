import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  AuthorizedSpaceSummary,
  ContentDirectoryNotebooksResponse,
  SpaceRuntimePathParameters,
  SpaceRuntimeBootstrap,
} from "@singularity/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  CircleOffIcon,
  GitForkIcon,
  LogOutIcon,
  OrbitIcon,
  SearchIcon,
  SearchXIcon,
  WifiOffIcon,
} from "lucide-react";
import { Link, Navigate, useLocation, useParams } from "react-router";

import {
  NetworkFailureError,
  isApiProblem,
  isRuntimeAccessLostProblem,
} from "@/api/http.ts";
import {
  AssetPreviewSurface,
  type AssetPreviewSurfaceRequest,
} from "@/assets/AssetPreviewSurface.tsx";
import { SessionRedirect } from "@/auth/SessionRedirect.tsx";
import { SPACES_PATH, locationTarget } from "@/auth/return-to.ts";
import { useLogout } from "@/auth/use-logout.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";
import {
  getAuthorizedSpaces,
  getSpaceRuntime,
  authorizedSpacesQueryKey,
  spaceRuntimeQueryKey,
} from "@/spaces/api.ts";
import { roleBadgeVariant, roleLabel } from "@/spaces/space-labels.ts";
import {
  EXPLICIT_SPACE_LIST_STATE,
  readSpaceDocumentNavigationState,
  spacePagePath,
} from "@/spaces/space-route.ts";
import {
  SpaceSessionRoot,
  type ProtyleMediatorEvent,
  type RuntimeErrorEvent,
} from "@/spaces/SpaceSessionRoot.tsx";
import {
  ContentDirectory,
  type ContentDirectoryAccessLoss,
  type ContentDirectoryStatus,
} from "@/spaces/ContentDirectory.tsx";
import type {
  ReadySpaceRuntimeBootstrap,
  SpaceProtyleMenuSurfaceFactory,
  SpaceProtyleRuntime,
  SpaceSessionComposition,
  SpaceSessionTerminalEvent,
} from "@/spaces/space-session.ts";
import {
  ProtyleHost,
  type ProtyleHostNavigationCommand,
} from "@/editor/ProtyleHost.tsx";
import type {
  ProtyleDocumentNavigation,
  ProtyleFactory,
} from "@singularity/protyle-browser";
import { useAuthorizedSpaces } from "@/spaces/use-authorized-spaces.ts";
import {
  contentDirectoryNotebooksQueryKey,
  contentDirectorySpaceQueryKey,
  getContentDirectoryNotebooks,
} from "@/spaces/content-directory-api.ts";
import type { ContentSelectionTarget } from "@/spaces/content-selection.ts";
import {
  DiscoveryPanel,
  type DiscoveryNavigationTarget,
} from "@/spaces/DiscoveryPanel.tsx";
import { useDiscoveryStore } from "@/spaces/discovery-state.ts";
import { CollaborationPanel } from "@/collaboration/CollaborationPanel.tsx";
import { RealtimeCollaborationHost } from "@/collaboration/RealtimeCollaborationHost.tsx";
import { DocumentGovernancePanel } from "@/enterprise/DocumentGovernancePanel.tsx";

const MAX_STARTING_POLLS = 30;
const STARTING_POLL_INTERVAL_MS = 2_000;

export type SpaceProtyleFactoryProvider = (
  spaceId: string,
) => ProtyleFactory<SpaceProtyleRuntime>;

export interface SpacePageProps {
  readonly createProtyleFactoryForSpace: SpaceProtyleFactoryProvider;
  readonly createProtyleMenuSurface: SpaceProtyleMenuSurfaceFactory;
}

interface SpaceNavigationCommand extends ProtyleHostNavigationCommand {
  readonly spaceId: string;
}

function isReadySpaceRuntime(
  runtime: SpaceRuntimeBootstrap | undefined,
): runtime is ReadySpaceRuntimeBootstrap {
  return runtime?.kernelState === "ready";
}

function isCurrentSpaceComposition(
  composition: SpaceSessionComposition | null,
  identity: SpaceRuntimePathParameters,
): composition is SpaceSessionComposition {
  return composition !== null &&
    composition.bootstrap.organizationId === identity.organizationId &&
    composition.bootstrap.spaceId === identity.spaceId;
}

function isActiveSpaceComposition(
  composition: SpaceSessionComposition | null,
  identity: SpaceRuntimePathParameters,
): composition is SpaceSessionComposition {
  return isCurrentSpaceComposition(composition, identity) &&
    composition.session !== null;
}

function resolveContentSelectionTarget(
  queryClient: ReturnType<typeof useQueryClient>,
  identity: SpaceRuntimePathParameters,
  target: Pick<ContentSelectionTarget, "documentId" | "notebookId">,
): ContentSelectionTarget | null {
  const directory = queryClient.getQueryData<ContentDirectoryNotebooksResponse>(
    contentDirectoryNotebooksQueryKey(identity),
  );
  const notebook = directory?.notebooks.find(
    (candidate) => candidate.notebookId === target.notebookId,
  );
  if (!notebook || notebook.locked) {
    return null;
  }
  return {
    ...target,
    supportsGraph: notebook.supportsGraph,
  };
}

function SessionTerminalBoundary({
  composition,
  event,
}: {
  readonly composition: SpaceSessionComposition | null;
  readonly event: SpaceSessionTerminalEvent;
}) {
  useEffect(() => {
    if (composition === null) {
      return;
    }
    let cancelled = false;
    void composition.requestTerminal(event).then((accepted) => {
      if (!cancelled && !accepted) {
        console.warn("[protyle.lifecycle]", {
          generation: composition.scope.generation,
          phase: "terminal",
          result: "stale-query-terminal-rejected",
          spaceId: composition.scope.spaceId,
          ...(event.triggeringRequestId
            ? { triggeringRequestId: event.triggeringRequestId }
            : {}),
        });
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        console.error("[protyle.lifecycle]", {
          error,
          generation: composition.scope.generation,
          phase: "terminal",
          result: "query-terminal-failed",
          spaceId: composition.scope.spaceId,
          ...(event.triggeringRequestId
            ? { triggeringRequestId: event.triggeringRequestId }
            : {}),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  // composition 是当前终止快照，依赖对象变化时必须重新绑定清理函数。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    composition?.requestTerminal,
    composition?.scope.generation,
    composition?.scope.spaceId,
    event.category,
    event.triggeringRequestId,
  ]);

  return (
    <WorkspaceState
      description="正在安全关闭当前内容会话。"
      media={<Spinner aria-label="正在关闭内容会话" />}
      title="正在更新访问状态"
    />
  );
}

function createSpaceHostMediator(
  queryClient: ReturnType<typeof useQueryClient>,
  composition: SpaceSessionComposition | null,
  queueNavigation: (
    spaceId: string,
    navigation: ProtyleDocumentNavigation,
  ) => void,
  openAssetPreview: (request: AssetPreviewSurfaceRequest) => void,
  event: ProtyleMediatorEvent,
  bootstrap: ReadySpaceRuntimeBootstrap,
): void {
  if (!isActiveSpaceComposition(composition, bootstrap)) {
    console.warn("[protyle.host]", {
      eventType: event.type,
      phase: "mediator",
      result: "stale-composition-rejected",
      spaceId: bootstrap.spaceId,
    });
    return;
  }
  switch (event.type) {
    case "open-document": {
      const target = resolveContentSelectionTarget(queryClient, bootstrap, {
        documentId: event.documentId,
        notebookId: event.notebookId,
      });
      if (!target) {
        console.warn("[protyle.host]", {
          documentId: event.documentId,
          eventType: event.type,
          notebookId: event.notebookId,
          phase: "selection",
          result: "notebook-capability-rejected",
          spaceId: bootstrap.spaceId,
        });
        return;
      }
      if (!composition.selectDocument(target)) {
        return;
      }
      if (event.navigation !== "none") {
        queueNavigation(bootstrap.spaceId, {
          attention: event.attention,
          blockId: event.blockId,
          documentId: event.documentId,
          notebookId: event.notebookId,
          restoreScroll: event.restoreScroll,
          scope: event.scope,
          scroll: event.scroll,
          zoom: event.zoom,
        });
      }
      return;
    }
    case "close-document": {
      const selection = composition.selection;
      if (
        selection?.spaceId === bootstrap.spaceId &&
        selection.notebookId === event.notebookId &&
        selection.documentId === event.documentId
      ) {
        composition.clearSelection();
      }
      useDiscoveryStore.getState().closeDocumentPanel({
        documentId: event.documentId,
        notebookId: event.notebookId,
        spaceId: bootstrap.spaceId,
      });
      return;
    }
    case "refresh-outline":
      useDiscoveryStore.getState().refreshDocumentPanel({
        documentId: event.documentId,
        kind: "outline",
        notebookId: event.notebookId,
        spaceId: bootstrap.spaceId,
      });
      return;
    case "refresh-backlinks":
      useDiscoveryStore.getState().refreshDocumentPanel({
        documentId: event.documentId,
        kind: "backlinks",
        notebookId: event.notebookId,
        spaceId: bootstrap.spaceId,
      });
      return;
    case "set-document-title":
    case "set-document-icon":
      void queryClient.invalidateQueries({
        queryKey: contentDirectorySpaceQueryKey({
          organizationId: bootstrap.organizationId,
          spaceId: bootstrap.spaceId,
        }),
      });
      return;
    case "open-asset": {
      openAssetPreview({
        assetPath: event.assetPath,
        documentId: event.documentId,
        ...(event.page === undefined ? {} : { initialPage: event.page }),
        notebookId: event.notebookId,
        organizationId: bootstrap.organizationId,
        spaceId: bootstrap.spaceId,
        title: event.assetPath,
      });
      return;
    }
    case "open-search":
      useDiscoveryStore.getState().openSpaceSearch({
        method: event.method,
        query: event.query,
        queryMode: event.queryMode,
        spaceId: bootstrap.spaceId,
      });
      return;
    case "open-document-search":
      useDiscoveryStore.getState().open({
        documentId: event.documentId,
        kind: "document-search",
        notebookId: event.notebookId,
        query: "",
        spaceId: bootstrap.spaceId,
      });
      return;
    case "open-outline":
      useDiscoveryStore.getState().open({
        documentId: event.documentId,
        kind: "outline",
        notebookId: event.notebookId,
        preview: event.preview,
        spaceId: bootstrap.spaceId,
      });
      return;
    case "open-backlinks":
      useDiscoveryStore.getState().open({
        documentId: event.documentId,
        kind: "backlinks",
        notebookId: event.notebookId,
        spaceId: bootstrap.spaceId,
      });
      return;
    case "open-document-history":
      useDiscoveryStore.getState().open({
        documentId: event.documentId,
        kind: "document-history",
        notebookId: event.notebookId,
        page: 1,
        spaceId: bootstrap.spaceId,
      });
      return;
    case "open-graph": {
      if (event.scope === "space") {
        useDiscoveryStore.getState().open({
          kind: "space-graph",
          query: "",
          spaceId: bootstrap.spaceId,
        });
        return;
      }
      const target = resolveContentSelectionTarget(queryClient, bootstrap, {
        documentId: event.documentId,
        notebookId: event.notebookId,
      });
      if (!target?.supportsGraph) {
        console.warn("[protyle.host]", {
          documentId: event.documentId,
          eventType: event.type,
          notebookId: event.notebookId,
          phase: "discovery",
          result: "document-graph-capability-rejected",
          spaceId: bootstrap.spaceId,
        });
        return;
      }
      useDiscoveryStore.getState().open({
        documentId: event.documentId,
        kind: "document-graph",
        notebookId: event.notebookId,
        query: "",
        spaceId: bootstrap.spaceId,
        supportsGraph: target.supportsGraph,
      });
      return;
    }
    case "open-external":
      window.open(event.url, "_blank", "noopener,noreferrer");
      return;
    case "activate-document":
    case "record-navigation-location":
    case "open-ai-actions":
    case "open-ai-writing":
    case "open-block-attributes":
    case "open-block-move":
    case "open-block-ref-transfer":
    case "open-block-reminder":
    case "open-table-menu":
    case "delete-document":
    case "open-document-export":
    case "open-document-move":
    case "persist-workspace-layout":
    case "rename-asset":
    case "share-document-community":
    case "toggle-document-fullscreen":
    case "upload-cloud-assets":
    case "update-document-statistics":
    case "notify":
      return;
    default:
      throw new Error(`[protyle.host] event ${event.type} has no React mediator`);
  }
}

function subscribeToVisibility(callback: () => void): () => void {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

function getVisibilitySnapshot(): DocumentVisibilityState {
  return document.visibilityState;
}

function usePageVisible(): boolean {
  return (
    useSyncExternalStore(
      subscribeToVisibility,
      getVisibilitySnapshot,
      getVisibilitySnapshot,
    ) === "visible"
  );
}

interface WorkspaceStateProps {
  actions?: ReactNode;
  description: string;
  icon?: ComponentType<{ "aria-hidden"?: boolean }>;
  media?: ReactNode;
  title: string;
}

function WorkspaceState({
  actions,
  description,
  icon: Icon,
  media,
  title,
}: WorkspaceStateProps) {
  return (
    <Empty aria-live="polite">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {media ?? (Icon ? <Icon aria-hidden={true} /> : null)}
        </EmptyMedia>
        <EmptyTitle>
          <h1>{title}</h1>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {actions ? <EmptyContent>{actions}</EmptyContent> : null}
    </Empty>
  );
}

interface WorkspaceFrameProps {
  children: ReactNode;
  currentSpace: AuthorizedSpaceSummary | null;
  logoutError: boolean;
  logoutPending: boolean;
  onOpenSpaceGraph: (() => void) | null;
  onOpenSpaceSearch: (() => void) | null;
  onLogout: () => void;
  role: AuthorizedSpaceSummary["role"] | null;
  spaces: AuthorizedSpaceSummary[];
}

interface WorkspaceSpaceLinkProps {
  active: boolean;
  space: AuthorizedSpaceSummary;
}

interface ReadyWorkspaceProps {
  readonly composition: SpaceSessionComposition;
  readonly createProtyleFactoryForSpace: SpaceProtyleFactoryProvider;
  readonly identity: SpaceRuntimePathParameters;
  readonly initialDocument: { readonly documentId: string; readonly notebookId: string } | null;
  readonly navigationCommand: ProtyleHostNavigationCommand | null;
  readonly onDirectoryAccessLost: (category: ContentDirectoryAccessLoss) => void;
  readonly onDirectoryStatusChange: (status: ContentDirectoryStatus) => void;
  readonly onDiscoveryNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly onNavigationCommandComplete: (sequence: number) => void;
  readonly readOnly: boolean;
  readonly status: ContentDirectoryStatus;
}

function ReadyWorkspace({
  composition,
  createProtyleFactoryForSpace,
  identity,
  initialDocument,
  navigationCommand,
  onDirectoryAccessLost,
  onDirectoryStatusChange,
  onDiscoveryNavigate,
  onNavigationCommandComplete,
  readOnly,
  status,
}: ReadyWorkspaceProps) {
  const { selection, session } = composition;
  const queryClient = useQueryClient();
  const initialDocumentKey = initialDocument === null
    ? null
    : `${identity.organizationId}:${identity.spaceId}:${initialDocument.notebookId}:${initialDocument.documentId}`;
  const appliedInitialDocumentRef = useRef<string | null>(null);
  const initialNotebooksQuery = useQuery({
    enabled: initialDocument !== null,
    queryKey: contentDirectoryNotebooksQueryKey(identity),
    queryFn: ({ signal }) => getContentDirectoryNotebooks(identity, signal),
    staleTime: 0,
  });
  const previousSessionRef = useRef(session);
  const factory = useMemo(
    () => createProtyleFactoryForSpace(identity.spaceId),
    [createProtyleFactoryForSpace, identity.spaceId],
  );
  const [editorAttempt, setEditorAttempt] = useState(0);
  const [editorError, setEditorError] = useState(false);
  const [editorRetrying, setEditorRetrying] = useState(false);

  useEffect(() => {
    // 文档身份变化时清除上一个编辑器的重试状态，避免错误沿用到新文档。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditorAttempt(0);
    setEditorError(false);
  }, [selection?.documentId, selection?.notebookId, session?.spaceId]);

  useEffect(() => {
    const sessionChanged = previousSessionRef.current !== session;
    previousSessionRef.current = session;
    if (
      navigationCommand &&
      (
        sessionChanged ||
        !selection ||
        selection.notebookId !== navigationCommand.navigation.notebookId ||
        selection.documentId !== navigationCommand.navigation.documentId
      )
    ) {
      onNavigationCommandComplete(navigationCommand.sequence);
    }
  }, [navigationCommand, onNavigationCommandComplete, selection, session]);

  const retryEditor = async () => {
    if (!session || editorRetrying) {
      return;
    }
    setEditorRetrying(true);
    try {
      await session.retrySubmission();
      setEditorError(false);
      setEditorAttempt((current) => current + 1);
    } catch (error) {
      console.error("[protyle.lifecycle]", {
        documentId: selection?.documentId,
        error,
        notebookId: selection?.notebookId,
        phase: "editor-retry",
        result: "failed",
        spaceId: identity.spaceId,
      });
      setEditorError(true);
    } finally {
      setEditorRetrying(false);
    }
  };

  const navigateToDocument = useCallback((target: {
    readonly documentId: string;
    readonly notebookId: string;
  }) => {
    const resolved = resolveContentSelectionTarget(queryClient, identity, target);
    if (resolved !== null) {
      composition.selectDocument(resolved);
    }
  }, [composition, identity, queryClient]);

  useEffect(() => {
    if (initialDocument === null || initialDocumentKey === null || initialNotebooksQuery.data === undefined || appliedInitialDocumentRef.current === initialDocumentKey) {
      return;
    }
    const resolved = resolveContentSelectionTarget(queryClient, identity, initialDocument);
    if (resolved === null) {
      console.warn("[space.navigation]", {
        documentId: initialDocument.documentId,
        notebookId: initialDocument.notebookId,
        result: "document-not-authorized-or-not-found",
        spaceId: identity.spaceId,
      });
      appliedInitialDocumentRef.current = initialDocumentKey;
      return;
    }
    if (composition.selectDocument(resolved)) {
      appliedInitialDocumentRef.current = initialDocumentKey;
    }
  }, [composition, identity, initialDocument, initialDocumentKey, initialNotebooksQuery.data, queryClient]);

  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden rounded-md border bg-background"
      data-content-directory-status={status}
    >
      <ContentDirectory
        identity={composition.scope}
        onAccessLost={onDirectoryAccessLost}
        onClear={composition.clearSelection}
        onSelect={composition.selectDocument}
        onStatusChange={onDirectoryStatusChange}
        selection={composition.selection}
      />
      <main className="min-h-0 min-w-0 flex-1" data-content-workspace>
        {session && selection ? (
          <div className="relative h-full min-h-0">
            <ProtyleHost
              key={`${session.spaceId}:${selection.notebookId}:${selection.documentId}:${editorAttempt}`}
              documentId={selection.documentId}
              factory={factory}
              navigationCommand={navigationCommand}
              notebookId={selection.notebookId}
              onError={(error) => {
                console.error("[protyle.lifecycle]", {
                  documentId: selection.documentId,
                  error,
                  notebookId: selection.notebookId,
                  phase: "editor",
                  result: "failed",
                  spaceId: identity.spaceId,
                });
                setEditorError(true);
              }}
              onNavigationCommandComplete={onNavigationCommandComplete}
              readOnly={readOnly}
              session={session}
            />
            <RealtimeCollaborationHost
              identity={{
                documentId: selection.documentId,
                notebookId: selection.notebookId,
                organizationId: identity.organizationId,
                spaceId: identity.spaceId,
              }}
              readOnly={readOnly}
              transport={session.runtime.transport}
            />
            {editorError ? (
              <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 rounded-md border bg-background/95 p-3 text-sm shadow-sm">
                <span className="text-muted-foreground">内容服务暂时不可用，当前编辑器未提交本次操作。</span>
                <Button disabled={editorRetrying} onClick={() => void retryEditor()} size="sm" variant="outline">
                  {editorRetrying ? <Spinner aria-label="正在重试编辑器" /> : null}
                  重试
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <WorkspaceState
            description="从左侧目录选择一个文档后开始工作。"
            icon={BookOpenIcon}
            title="选择文档"
          />
        )}
      </main>
      <CollaborationPanel
        key={
          selection === null
            ? "empty"
            : `${identity.organizationId}:${identity.spaceId}:${selection.notebookId}:${selection.documentId}`
        }
        identity={
          selection === null
            ? null
            : {
                documentId: selection.documentId,
                notebookId: selection.notebookId,
                organizationId: identity.organizationId,
                spaceId: identity.spaceId,
              }
        }
        onNavigate={navigateToDocument}
      />
      {selection ? (
        <DocumentGovernancePanel
          key={`${identity.organizationId}:${identity.spaceId}:${selection.notebookId}:${selection.documentId}`}
          identity={{
            documentId: selection.documentId,
            notebookId: selection.notebookId,
            organizationId: identity.organizationId,
            spaceId: identity.spaceId,
          }}
          onNavigateCitation={(target) => {
            if (target.organizationId !== identity.organizationId || target.spaceId !== identity.spaceId) {
              console.warn("[governance.ai-citation]", {
                documentId: target.documentId,
                organizationId: target.organizationId,
                result: "cross-space-navigation-rejected",
                spaceId: target.spaceId,
              });
              return;
            }
            navigateToDocument(target);
          }}
        />
      ) : null}
      {session ? (
        <DiscoveryPanel
          onNavigate={onDiscoveryNavigate}
          organizationId={identity.organizationId}
          session={session}
          spaceId={identity.spaceId}
        />
      ) : null}
    </div>
  );
}

function WorkspaceSpaceLink({ active, space }: WorkspaceSpaceLinkProps) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={space.spaceName}
      >
        <Link
          aria-current={active ? "page" : undefined}
          onClick={() => {
            if (isMobile) {
              setOpenMobile(false);
            }
          }}
          to={spacePagePath(space)}
        >
          <BookOpenIcon aria-hidden="true" />
          <span title={space.spaceName}>{space.spaceName}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceFrame({
  children,
  currentSpace,
  logoutError,
  logoutPending,
  onOpenSpaceGraph,
  onOpenSpaceSearch,
  onLogout,
  role,
  spaces,
}: WorkspaceFrameProps) {
  return (
    <div data-singularity-ui className="min-h-dvh">
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader className="h-10 justify-center border-b border-sidebar-border px-2 py-0">
            <div className="flex min-w-0 items-center gap-2 px-1.5 text-sm font-semibold">
              <OrbitIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate group-data-[collapsible=icon]:hidden">
                奇点
              </span>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>知识空间</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {spaces.map((space) => {
                    const active = currentSpace?.spaceId === space.spaceId;
                    return (
                      <WorkspaceSpaceLink
                        active={active}
                        key={space.spaceId}
                        space={space}
                      />
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border p-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  disabled={logoutPending}
                  onClick={onLogout}
                  tooltip="退出登录"
                >
                  {logoutPending ? (
                    <Spinner aria-label="正在退出" />
                  ) : (
                    <LogOutIcon aria-hidden="true" />
                  )}
                  <span>退出登录</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <SidebarTrigger />
            <Button asChild size="icon-sm" variant="ghost">
              <Link
                aria-label="返回空间列表"
                state={EXPLICIT_SPACE_LIST_STATE}
                to={SPACES_PATH}
              >
                <ArrowLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-4" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-xs text-muted-foreground">
                {currentSpace?.organizationName ?? "知识空间"}
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                /
              </span>
              <span className="truncate text-sm font-medium">
                {currentSpace?.spaceName ?? "正在加载"}
              </span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="搜索当前空间"
                  disabled={onOpenSpaceSearch === null}
                  onClick={onOpenSpaceSearch ?? undefined}
                  size="icon-sm"
                  variant="ghost"
                >
                  <SearchIcon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>搜索当前空间</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="打开空间关系图"
                  disabled={onOpenSpaceGraph === null}
                  onClick={onOpenSpaceGraph ?? undefined}
                  size="icon-sm"
                  variant="ghost"
                >
                  <GitForkIcon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>打开空间关系图</TooltipContent>
            </Tooltip>
            {role ? (
              <Badge className="shrink-0" variant={roleBadgeVariant(role)}>
                {roleLabel(role)}
              </Badge>
            ) : null}
          </header>

          {logoutError ? (
            <div className="p-3 pb-0">
              <Alert variant="destructive">
                <AlertTitle>无法退出</AlertTitle>
                <AlertDescription>请检查网络连接后重试。</AlertDescription>
              </Alert>
            </div>
          ) : null}

          <section className="flex min-h-0 flex-1 items-stretch justify-center p-2 max-sm:p-2">
            {children}
          </section>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

export function SpacePage({
  createProtyleFactoryForSpace,
  createProtyleMenuSurface,
}: SpacePageProps) {
  const location = useLocation();
  const requestedDocument = useMemo(() => readSpaceDocumentNavigationState(location.state), [location.state]);
  const params = useParams();
  const organizationId = params.organizationId ?? "";
  const spaceId = params.spaceId ?? "";
  const routeKey = `${organizationId}:${spaceId}`;
  const identity = useMemo<SpaceRuntimePathParameters>(
    () => ({ organizationId, spaceId }),
    [organizationId, spaceId],
  );
  const queryClient = useQueryClient();
  const compositionRef = useRef<SpaceSessionComposition | null>(null);
  const logoutTerminalRef = useRef(false);
  const navigationSequenceRef = useRef(0);
  const routeKeyRef = useRef(routeKey);
  useLayoutEffect(() => {
    routeKeyRef.current = routeKey;
  }, [routeKey]);
  const [navigationCommand, setNavigationCommand] = useState<SpaceNavigationCommand | null>(null);
  const spacesQuery = useAuthorizedSpaces();
  const runtimeQuery = useQuery({
    enabled: organizationId !== "" && spaceId !== "",
    queryKey: spaceRuntimeQueryKey(identity),
    queryFn: ({ signal }) => getSpaceRuntime(identity, signal),
    refetchOnMount: "always",
    staleTime: 0,
  });
  const hasCurrentRuntime =
    runtimeQuery.isSuccess &&
    runtimeQuery.isFetchedAfterMount &&
    !runtimeQuery.isFetching &&
    !runtimeQuery.isPaused;
  const runtime =
    hasCurrentRuntime ? runtimeQuery.data : undefined;
  const runtimeDataUpdatedAt = runtime ? runtimeQuery.dataUpdatedAt : 0;
  const runtimeError = runtimeQuery.error;
  const runtimeIsFetching = runtimeQuery.isFetching;
  const runtimeKernelState = runtime?.kernelState;
  const refetchRuntime = runtimeQuery.refetch;
  /** 捕获退出发起时的空间 scope 和 generation，防止迟到 logout 终止后来建立的 Session。 */
  const captureLogoutTermination = useCallback(() => {
    const capturedRouteKey = routeKey;
    const capturedComposition = compositionRef.current;
    const capturedScope = isCurrentSpaceComposition(
      capturedComposition,
      { organizationId, spaceId },
    )
      ? capturedComposition.scope
      : null;
    const capturedGeneration = capturedScope?.generation ?? null;

    return async () => {
      const composition = compositionRef.current;
      if (capturedScope === null) {
        if (
          capturedComposition === null &&
          routeKeyRef.current === capturedRouteKey &&
          composition === null
        ) {
          return;
        }
        throw new DOMException(
          "The active space session changed during logout",
          "AbortError",
        );
      }
      if (
        routeKeyRef.current !== capturedRouteKey ||
        composition === null ||
        composition.scope !== capturedScope ||
        composition.scope.generation !== capturedGeneration ||
        !isCurrentSpaceComposition(composition, { organizationId, spaceId })
      ) {
        throw new DOMException(
          "The active space session changed during logout",
          "AbortError",
        );
      }
      logoutTerminalRef.current = true;
      try {
        const accepted = await composition.requestTerminal({
          category: "unauthenticated",
          type: "runtime-error",
        });
        if (!accepted) {
          throw new DOMException(
            "The active space session changed during logout",
            "AbortError",
          );
        }
      } finally {
        logoutTerminalRef.current = false;
      }
    };
  }, [organizationId, routeKey, spaceId]);
  const logoutMutation = useLogout(captureLogoutTermination);
  const pageVisible = usePageVisible();
  const [pollState, setPollState] = useState({ attempts: 0, routeKey });
  const [sessionFailure, setSessionFailure] = useState<{
    readonly category: "forbidden" | "unauthenticated";
    readonly routeKey: string;
  } | null>(null);
  const [acceptedSession, setAcceptedSession] = useState<{
    readonly bootstrap: ReadySpaceRuntimeBootstrap;
    readonly routeKey: string;
  } | null>(null);
  const [directoryStatus, setDirectoryStatus] = useState<ContentDirectoryStatus>("loading");
  const [assetPreviewRequest, setAssetPreviewRequest] = useState<
    AssetPreviewSurfaceRequest | null
  >(null);

  useEffect(() => {
    // 空间路由切换时清除旧导航、预览和组合根，阻断迟到响应回写。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNavigationCommand(null);
    setAssetPreviewRequest(null);
    setDirectoryStatus("loading");
    compositionRef.current = null;
    logoutTerminalRef.current = false;
    useDiscoveryStore.getState().reset();
  }, [routeKey]);

  const currentSessionFailure = sessionFailure?.routeKey === routeKey
    ? sessionFailure
    : null;
  const handleSessionAccessLost = useCallback(async (
    event: RuntimeErrorEvent,
    failedBootstrap: ReadySpaceRuntimeBootstrap,
  ) => {
    // 终止当前组合根后重新读取授权与运行时；只有两者都仍属于当前代次才允许恢复。
    if (event.category !== "unauthenticated" && event.category !== "forbidden") {
      return;
    }
    const failedRouteKey = `${failedBootstrap.organizationId}:${failedBootstrap.spaceId}`;
    const category = event.category === "unauthenticated"
      ? "unauthenticated"
      : "forbidden";
    compositionRef.current = null;
    queryClient.removeQueries({
      queryKey: contentDirectorySpaceQueryKey(failedBootstrap),
    });
    setAssetPreviewRequest((current) =>
      current?.spaceId === failedBootstrap.spaceId ? null : current
    );
    useDiscoveryStore.getState().close(failedBootstrap.spaceId);
    if (routeKeyRef.current !== failedRouteKey) {
      return;
    }
    if (category === "unauthenticated" && logoutTerminalRef.current) {
      return;
    }
    setSessionFailure({ category, routeKey: failedRouteKey });
    if (category === "unauthenticated") {
      return;
    }
    const [spacesResult, runtimeResult] = await Promise.allSettled([
      queryClient.fetchQuery({
        queryFn: ({ signal }) => getAuthorizedSpaces(signal),
        queryKey: authorizedSpacesQueryKey,
        staleTime: 0,
      }),
      queryClient.fetchQuery({
        queryFn: ({ signal }) => getSpaceRuntime(failedBootstrap, signal),
        queryKey: spaceRuntimeQueryKey(failedBootstrap),
        staleTime: 0,
      }),
    ]);
    if (spacesResult.status === "rejected") {
      const spacesError: unknown = spacesResult.reason;
      console.warn("[protyle.lifecycle]", {
        error: spacesError,
        phase: "reauthorize",
        result: "spaces-failed",
        spaceId: failedBootstrap.spaceId,
      });
    }
    if (runtimeResult.status === "rejected") {
      const runtimeError: unknown = runtimeResult.reason;
      console.warn("[protyle.lifecycle]", {
        ...(isRuntimeAccessLostProblem(runtimeError)
          ? { category: "forbidden" }
          : {}),
        error: runtimeError,
        phase: "reauthorize",
        result: "runtime-failed",
        spaceId: failedBootstrap.spaceId,
      });
    }
    if (
      spacesResult.status !== "fulfilled" ||
      runtimeResult.status !== "fulfilled" ||
      !isReadySpaceRuntime(runtimeResult.value) ||
      runtimeResult.value.organizationId !== failedBootstrap.organizationId ||
      runtimeResult.value.spaceId !== failedBootstrap.spaceId ||
      !spacesResult.value.spaces.some(
        (space) =>
          space.organizationId === failedBootstrap.organizationId &&
          space.spaceId === failedBootstrap.spaceId,
      ) ||
      routeKeyRef.current !== failedRouteKey
    ) {
      return;
    }
    setAcceptedSession({
      bootstrap: runtimeResult.value,
      routeKey: failedRouteKey,
    });
    setSessionFailure((current) =>
      current?.category === "forbidden" && current.routeKey === failedRouteKey
        ? null
        : current,
    );
  }, [queryClient]);
  const handleDirectoryAccessLost = useCallback(async (
    event: ContentDirectoryAccessLoss,
  ) => {
    const composition = compositionRef.current;
    if (!isCurrentSpaceComposition(composition, { organizationId, spaceId })) {
      return;
    }
    const accepted = await composition.requestTerminal(event);
    if (!accepted) {
      console.warn("[content.directory]", {
        generation: composition.scope.generation,
        phase: "access",
        result: "stale-terminal-rejected",
        spaceId: composition.scope.spaceId,
        ...(event.triggeringRequestId
          ? { triggeringRequestId: event.triggeringRequestId }
          : {}),
      });
    }
  }, [organizationId, spaceId]);
  const queueNavigation = useCallback((
    targetSpaceId: string,
    navigation: ProtyleDocumentNavigation,
  ) => {
    setNavigationCommand({
      navigation,
      sequence: ++navigationSequenceRef.current,
      spaceId: targetSpaceId,
    });
  }, [setNavigationCommand]);
  const completeNavigationCommand = useCallback((sequence: number) => {
    setNavigationCommand((current) =>
      current?.sequence === sequence ? null : current,
    );
  }, [setNavigationCommand]);
  // 该回调读取组合根的可变句柄，必须保留稳定引用供面板事件使用。
  const handleDiscoveryNavigate = useCallback((target: DiscoveryNavigationTarget) => {
    const composition = compositionRef.current;
    if (
      !isReadySpaceRuntime(runtime) ||
      runtime.organizationId !== organizationId ||
      runtime.spaceId !== spaceId ||
      currentSessionFailure !== null ||
      !isActiveSpaceComposition(composition, identity)
    ) {
      console.warn("[discovery.panel]", {
        phase: "navigation",
        result: "stale-composition-rejected",
        spaceId,
      });
      return;
    }
    const selectionTarget = resolveContentSelectionTarget(
      queryClient,
      identity,
      {
        documentId: target.documentId,
        notebookId: target.notebookId,
      },
    );
    if (!selectionTarget) {
      console.warn("[discovery.panel]", {
        documentId: target.documentId,
        notebookId: target.notebookId,
        phase: "navigation",
        result: "notebook-capability-rejected",
        spaceId,
      });
      return;
    }
    if (!composition.selectDocument(selectionTarget)) {
      return;
    }
    queueNavigation(runtime.spaceId, {
      attention: "focus",
      blockId: target.blockId,
      documentId: target.documentId,
      notebookId: target.notebookId,
      restoreScroll: "if-document",
      scope: "target",
      scroll: "auto",
      zoom: false,
    });
  }, [
    currentSessionFailure,
    identity,
    organizationId,
    queryClient,
    queueNavigation,
    runtime,
    spaceId,
  ]);
  const openSpaceSearch = useCallback(() => {
    if (
      !isReadySpaceRuntime(runtime) ||
      runtime.organizationId !== organizationId ||
      runtime.spaceId !== spaceId ||
      currentSessionFailure !== null
    ) {
      return;
    }
    useDiscoveryStore.getState().openSpaceSearch({
      method: "preferred",
      query: "",
      queryMode: "replace",
      spaceId: runtime.spaceId,
    });
  }, [currentSessionFailure, organizationId, runtime, spaceId]);
  const openSpaceGraph = useCallback(() => {
    if (
      !isReadySpaceRuntime(runtime) ||
      runtime.organizationId !== organizationId ||
      runtime.spaceId !== spaceId ||
      currentSessionFailure !== null
    ) {
      return;
    }
    useDiscoveryStore.getState().open({
      kind: "space-graph",
      query: "",
      spaceId: runtime.spaceId,
    });
  }, [currentSessionFailure, organizationId, runtime, spaceId]);
  const handleAssetPreview = useCallback((request: AssetPreviewSurfaceRequest) => {
    setAssetPreviewRequest(request);
  }, []);
  const handleHostEvent = useCallback(
    (event: ProtyleMediatorEvent, bootstrap: ReadySpaceRuntimeBootstrap) => {
      createSpaceHostMediator(
        queryClient,
        compositionRef.current,
        queueNavigation,
        handleAssetPreview,
        event,
        bootstrap,
      );
    },
    [handleAssetPreview, queryClient, queueNavigation],
  );
  const pollAttempts =
    pollState.routeKey === routeKey ? pollState.attempts : 0;
  const runtimeNotFound =
    runtimeQuery.isFetchedAfterMount &&
    !runtimeQuery.isFetching &&
    !runtimeQuery.isPaused &&
    isApiProblem(runtimeQuery.error, "not-found");
  useEffect(() => {
    if (!runtimeNotFound) {
      return;
    }
    // 运行时明确返回 404 后重新确认授权列表，避免继续展示已撤销的空间。
    void queryClient.invalidateQueries({ queryKey: authorizedSpacesQueryKey }).catch(
      (error: unknown) => {
        console.warn("[protyle.lifecycle]", {
          error,
          phase: "authorization-refresh",
          result: "failed",
          routeKey,
        });
      },
    );
  }, [queryClient, routeKey, runtimeNotFound]);
  const hasCurrentAuthorization =
    spacesQuery.isSuccess &&
    spacesQuery.isFetchedAfterMount &&
    !spacesQuery.isFetching &&
    !spacesQuery.isPaused;
  const authorizedSpaces =
    hasCurrentAuthorization ? spacesQuery.data.spaces : [];
  const hideCurrentSpace = runtimeNotFound || currentSessionFailure?.category === "forbidden";
  const spaces = hideCurrentSpace
    ? authorizedSpaces.filter(
        (space) =>
          space.organizationId !== organizationId || space.spaceId !== spaceId,
      )
    : authorizedSpaces;
  const currentSpace =
    spaces.find(
      (space) =>
        space.organizationId === organizationId && space.spaceId === spaceId,
    ) ?? null;
  const freshReadyBootstrap =
    isReadySpaceRuntime(runtime) &&
    runtime.organizationId === organizationId &&
    runtime.spaceId === spaceId &&
    currentSpace !== null &&
    currentSessionFailure === null
      ? runtime
      : null;
  useEffect(() => {
    if (freshReadyBootstrap === null) {
      return;
    }
    // 该状态保存已通过授权检查的 bootstrap，避免异步刷新覆盖当前 Session。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcceptedSession((current) => {
      if (
        current?.routeKey === routeKey &&
        current.bootstrap.role === freshReadyBootstrap.role
      ) {
        return current;
      }
      return { bootstrap: freshReadyBootstrap, routeKey };
    });
  }, [freshReadyBootstrap, routeKey]);
  const acceptedBootstrap = acceptedSession?.routeKey === routeKey
    ? acceptedSession.bootstrap
    : freshReadyBootstrap;
  const sessionBootstrap = currentSessionFailure === null
    ? acceptedBootstrap
    : null;
  let queryTerminalEvent: SpaceSessionTerminalEvent | null = null;
  if (
    isApiProblem(spacesQuery.error, "unauthenticated") ||
    isApiProblem(runtimeQuery.error, "unauthenticated")
  ) {
    const error = isApiProblem(runtimeQuery.error, "unauthenticated")
      ? runtimeQuery.error
      : isApiProblem(spacesQuery.error, "unauthenticated")
        ? spacesQuery.error
        : null;
    queryTerminalEvent = {
      category: "unauthenticated",
      ...(error ? { triggeringRequestId: error.problem.requestId } : {}),
      type: "runtime-error",
    };
  } else if (
    runtimeNotFound ||
    isApiProblem(runtimeQuery.error, "forbidden") ||
    (hasCurrentAuthorization && currentSpace === null)
  ) {
    const error = isApiProblem(runtimeQuery.error, "not-found") ||
      isApiProblem(runtimeQuery.error, "forbidden")
      ? runtimeQuery.error
      : null;
    queryTerminalEvent = {
      category: "forbidden",
      ...(error ? { triggeringRequestId: error.problem.requestId } : {}),
      type: "runtime-error",
    };
  }

  useEffect(() => {
    if (
      runtimeKernelState !== "starting" ||
      runtimeError ||
      runtimeIsFetching ||
      !hasCurrentAuthorization ||
      !currentSpace ||
      !pageVisible ||
      pollAttempts >= MAX_STARTING_POLLS
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setPollState((current) => ({
        attempts:
          current.routeKey === routeKey ? current.attempts + 1 : 1,
        routeKey,
      }));
      void refetchRuntime();
    }, STARTING_POLL_INTERVAL_MS);

    return () => window.clearTimeout(timeout);
  }, [
    pageVisible,
    pollAttempts,
    routeKey,
    runtimeKernelState,
    runtimeDataUpdatedAt,
    runtimeError,
    runtimeIsFetching,
    refetchRuntime,
    hasCurrentAuthorization,
    currentSpace,
  ]);

  if (!organizationId || !spaceId) {
    return <Navigate replace to={SPACES_PATH} />;
  }

  if (
    currentSessionFailure?.category === "unauthenticated" ||
    (queryTerminalEvent?.category === "unauthenticated" &&
      acceptedBootstrap === null)
  ) {
    return <SessionRedirect returnTo={locationTarget(location)} />;
  }

  const runtimeMatchesRoute =
    runtime?.organizationId === organizationId && runtime.spaceId === spaceId;
  const role = sessionBootstrap?.role ?? null;
  const retryRuntime = () => {
    setPollState({ attempts: 0, routeKey });
    void refetchRuntime();
  };
  const retrySessionRuntime = async () => {
    const result = await refetchRuntime();
    if (!result.isSuccess) {
      throw result.error ?? new Error("Space runtime retry failed");
    }
    return result.data;
  };
  const actions = (
    <div className="flex flex-wrap justify-center gap-2">
      <Button onClick={retryRuntime} variant="outline">
        立即重试
      </Button>
      <Button asChild variant="ghost">
        <Link state={EXPLICIT_SPACE_LIST_STATE} to={SPACES_PATH}>
          返回空间列表
        </Link>
      </Button>
    </div>
  );

  let content: ReactNode;
  if (spacesQuery.isPaused || runtimeQuery.isPaused) {
    content = (
      <WorkspaceState
        actions={actions}
        description="无法连接到服务，请检查网络后重试。"
        icon={WifiOffIcon}
        title="无法加载空间"
      />
    );
  } else if (runtimeNotFound) {
    content = (
      <WorkspaceState
        actions={
          <Button asChild variant="outline">
            <Link state={EXPLICIT_SPACE_LIST_STATE} to={SPACES_PATH}>
              返回空间列表
            </Link>
          </Button>
        }
        description="该空间不存在，或你已不再拥有访问权限。"
        icon={SearchXIcon}
        title="找不到该空间"
      />
    );
  } else if (currentSessionFailure?.category === "forbidden") {
    content = (
      <WorkspaceState
        actions={
          <Button asChild variant="outline">
            <Link state={EXPLICIT_SPACE_LIST_STATE} to={SPACES_PATH}>
              返回空间列表
            </Link>
          </Button>
        }
        description="该空间不存在，或你已不再拥有访问权限。"
        icon={SearchXIcon}
        title="找不到该空间"
      />
    );
  } else if (
    spacesQuery.isPending ||
    spacesQuery.isFetching ||
    runtimeQuery.isPending ||
    runtimeQuery.isFetching
  ) {
    content = (
      <WorkspaceState
        description="正在读取最新授权与内容服务状态。"
        media={<Spinner aria-label="正在加载空间" />}
        title="正在加载空间"
      />
    );
  } else if (spacesQuery.isError) {
    content = (
      <WorkspaceState
        actions={actions}
        description={
          spacesQuery.error instanceof NetworkFailureError
            ? "无法连接到服务，请检查网络后重试。"
            : "服务返回了无法处理的结果，请重试。"
        }
        icon={WifiOffIcon}
        title="无法加载空间"
      />
    );
  } else if (
    isApiProblem(runtimeQuery.error, "forbidden") ||
    (hasCurrentAuthorization && !currentSpace)
  ) {
    content = (
      <WorkspaceState
        actions={
          <Button asChild variant="outline">
            <Link state={EXPLICIT_SPACE_LIST_STATE} to={SPACES_PATH}>
              返回空间列表
            </Link>
          </Button>
        }
        description="该空间不存在，或你已不再拥有访问权限。"
        icon={SearchXIcon}
        title="找不到该空间"
      />
    );
  } else if (isApiProblem(runtimeQuery.error, "service-unavailable")) {
    content = (
      <WorkspaceState
        actions={actions}
        description="内容服务当前不可用，请稍后重试。"
        icon={CircleOffIcon}
        title="内容服务暂不可用"
      />
    );
  } else if (runtimeQuery.isError) {
    const networkFailure = runtimeQuery.error instanceof NetworkFailureError;
    content = (
      <WorkspaceState
        actions={actions}
        description={
          networkFailure
            ? "无法连接到服务，请检查网络后重试。"
            : "服务返回了无法处理的结果，请重试。"
        }
        icon={WifiOffIcon}
        title="无法加载空间"
      />
    );
  } else if (runtime?.kernelState === "unavailable") {
    content = (
      <WorkspaceState
        actions={actions}
        description="内容服务当前不可用，请稍后重试。"
        icon={CircleOffIcon}
        title="内容服务暂不可用"
      />
    );
  } else if (!runtimeMatchesRoute) {
    content = (
      <WorkspaceState
        actions={actions}
        description="服务返回了无法处理的结果，请重试。"
        icon={WifiOffIcon}
        title="无法加载空间"
      />
    );
  } else if (runtime?.kernelState === "starting") {
    content = (
      <WorkspaceState
        actions={actions}
        description={
          pollAttempts >= MAX_STARTING_POLLS
            ? "内容服务仍在启动，请稍后重试。"
            : "系统正在准备内容服务。"
        }
        media={<Spinner aria-label="空间启动中" />}
        title="空间正在启动"
      />
    );
  } else if (runtime?.kernelState === "ready") {
    content = null;
  } else {
    content = (
      <WorkspaceState
        actions={actions}
        description="服务返回了无法处理的结果，请重试。"
        icon={WifiOffIcon}
        title="无法加载空间"
      />
    );
  }

  return (
    <WorkspaceFrame
      currentSpace={currentSpace}
      logoutError={
        logoutMutation.isError &&
        !isApiProblem(logoutMutation.error, "unauthenticated")
      }
      logoutPending={logoutMutation.isPending}
      onOpenSpaceGraph={sessionBootstrap ? openSpaceGraph : null}
      onOpenSpaceSearch={sessionBootstrap ? openSpaceSearch : null}
      onLogout={() => logoutMutation.mutate()}
      role={role}
      spaces={spaces}
    >
      <SpaceSessionRoot
        bootstrap={sessionBootstrap}
        createProtyleMenuSurface={createProtyleMenuSurface}
        onAccessLost={handleSessionAccessLost}
        onHostEvent={handleHostEvent}
        retryRuntime={retrySessionRuntime}
      >
        {(composition) => {
          compositionRef.current = composition;
          if (sessionBootstrap && queryTerminalEvent) {
            return (
              <SessionTerminalBoundary
                composition={composition}
                event={queryTerminalEvent}
              />
            );
          }
          if (!sessionBootstrap) {
            return content;
          }
          if (!isCurrentSpaceComposition(composition, sessionBootstrap)) {
            return (
              <WorkspaceState
                description="正在准备当前空间的内容会话。"
                media={<Spinner aria-label="正在准备内容会话" />}
                title="正在准备内容会话"
              />
            );
          }
          return (
            <ReadyWorkspace
              composition={composition}
              createProtyleFactoryForSpace={createProtyleFactoryForSpace}
              identity={sessionBootstrap}
              initialDocument={requestedDocument}
              navigationCommand={
                navigationCommand?.spaceId === sessionBootstrap.spaceId
                  ? navigationCommand
                  : null
              }
              onDirectoryAccessLost={(event) => {
                void handleDirectoryAccessLost(event);
              }}
              onDirectoryStatusChange={setDirectoryStatus}
              onDiscoveryNavigate={handleDiscoveryNavigate}
              onNavigationCommandComplete={completeNavigationCommand}
              readOnly={sessionBootstrap.role === "viewer"}
              status={directoryStatus}
            />
          );
        }}
      </SpaceSessionRoot>
      <AssetPreviewSurface
        onClose={() => setAssetPreviewRequest(null)}
        request={
          assetPreviewRequest?.organizationId === organizationId &&
            assetPreviewRequest.spaceId === spaceId
            ? assetPreviewRequest
            : null
        }
      />
    </WorkspaceFrame>
  );
}
