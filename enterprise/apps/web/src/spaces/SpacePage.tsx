import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  AuthorizedSpaceSummary,
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

import { NetworkFailureError, isApiProblem } from "@/api/http.ts";
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
  getSpaceRuntime,
  authorizedSpacesQueryKey,
  spaceRuntimeQueryKey,
} from "@/spaces/api.ts";
import { roleBadgeVariant, roleLabel } from "@/spaces/space-labels.ts";
import {
  EXPLICIT_SPACE_LIST_STATE,
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
import { contentDirectorySpaceQueryKey } from "@/spaces/content-directory-api.ts";
import {
  DiscoveryPanel,
  type DiscoveryNavigationTarget,
} from "@/spaces/DiscoveryPanel.tsx";
import { useDiscoveryStore } from "@/spaces/discovery-state.ts";

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
    case "open-document":
      if (!composition.selectDocument({
        documentId: event.documentId,
        notebookId: event.notebookId,
      })) {
        return;
      }
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
      return;
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
    case "open-graph":
      useDiscoveryStore.getState().open(
        event.scope === "space"
          ? {
              kind: "space-graph",
              query: "",
              spaceId: bootstrap.spaceId,
            }
          : {
              documentId: event.documentId,
              kind: "document-graph",
              notebookId: event.notebookId,
              query: "",
              spaceId: bootstrap.spaceId,
            },
      );
      return;
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
  navigationCommand,
  onDirectoryAccessLost,
  onDirectoryStatusChange,
  onDiscoveryNavigate,
  onNavigationCommandComplete,
  readOnly,
  status,
}: ReadyWorkspaceProps) {
  const { selection, session } = composition;
  const previousSessionRef = useRef(session);
  const factory = useMemo(
    () => createProtyleFactoryForSpace(identity.spaceId),
    [createProtyleFactoryForSpace, identity.spaceId],
  );
  const [editorAttempt, setEditorAttempt] = useState(0);
  const [editorError, setEditorError] = useState(false);
  const [editorRetrying, setEditorRetrying] = useState(false);

  useEffect(() => {
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
    } catch {
      setEditorError(true);
    } finally {
      setEditorRetrying(false);
    }
  };

  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden rounded-md border bg-background"
      data-content-directory-status={status}
    >
      <ContentDirectory
        onAccessLost={onDirectoryAccessLost}
        onStatusChange={onDirectoryStatusChange}
        scope={composition.scope}
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
              onError={() => setEditorError(true)}
              onNavigationCommandComplete={onNavigationCommandComplete}
              readOnly={readOnly}
              session={session}
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
  const params = useParams();
  const organizationId = params.organizationId ?? "";
  const spaceId = params.spaceId ?? "";
  const identity: SpaceRuntimePathParameters = { organizationId, spaceId };
  const queryClient = useQueryClient();
  const compositionRef = useRef<SpaceSessionComposition | null>(null);
  const navigationSequenceRef = useRef(0);
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
  const logoutMutation = useLogout();
  const pageVisible = usePageVisible();
  const routeKey = `${organizationId}:${spaceId}`;
  const [pollState, setPollState] = useState({ attempts: 0, routeKey });
  const [sessionFailure, setSessionFailure] = useState<{
    readonly category: "forbidden" | "unauthenticated";
    readonly routeKey: string;
  } | null>(null);
  const [directoryStatus, setDirectoryStatus] = useState<ContentDirectoryStatus>("loading");
  const [assetPreviewRequest, setAssetPreviewRequest] = useState<
    AssetPreviewSurfaceRequest | null
  >(null);

  useEffect(() => {
    setNavigationCommand(null);
    setAssetPreviewRequest(null);
    setDirectoryStatus("loading");
    compositionRef.current = null;
    useDiscoveryStore.getState().reset();
  }, [routeKey]);

  const currentSessionFailure = sessionFailure?.routeKey === routeKey
    ? sessionFailure
    : null;
  const handleSessionAccessLost = useCallback(async (
    event: RuntimeErrorEvent,
    failedBootstrap: ReadySpaceRuntimeBootstrap,
  ) => {
    if (event.category !== "unauthenticated" && event.category !== "forbidden") {
      return;
    }
    const failedRouteKey = `${failedBootstrap.organizationId}:${failedBootstrap.spaceId}`;
    const category = event.category === "unauthenticated"
      ? "unauthenticated"
      : "forbidden";
    compositionRef.current = null;
    setSessionFailure({ category, routeKey: failedRouteKey });
    setAssetPreviewRequest((current) =>
      current?.spaceId === failedBootstrap.spaceId ? null : current
    );
    useDiscoveryStore.getState().close(failedBootstrap.spaceId);
    if (category === "unauthenticated") {
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({
        exact: true,
        queryKey: authorizedSpacesQueryKey,
      }),
      queryClient.invalidateQueries({
        exact: true,
        queryKey: spaceRuntimeQueryKey(failedBootstrap),
      }),
    ]);
  }, [queryClient]);
  const handleDirectoryAccessLost = useCallback(async (
    event: ContentDirectoryAccessLoss,
  ) => {
    const composition = compositionRef.current;
    if (!isCurrentSpaceComposition(composition, identity)) {
      return;
    }
    if (composition.session) {
      composition.session.runtime.host.dispatch(event);
      return;
    }
    await handleSessionAccessLost(event, composition.bootstrap);
  }, [handleSessionAccessLost, identity]);
  const queueNavigation = useCallback((
    targetSpaceId: string,
    navigation: ProtyleDocumentNavigation,
  ) => {
    setNavigationCommand({
      navigation,
      sequence: ++navigationSequenceRef.current,
      spaceId: targetSpaceId,
    });
  }, []);
  const completeNavigationCommand = useCallback((sequence: number) => {
    setNavigationCommand((current) =>
      current?.sequence === sequence ? null : current,
    );
  }, []);
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
    if (!composition.selectDocument({
      documentId: target.documentId,
      notebookId: target.notebookId,
    })) {
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
  }, [currentSessionFailure, identity, organizationId, queueNavigation, runtime, spaceId]);
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

  useEffect(() => {
    if (!runtimeNotFound) {
      return;
    }

    void queryClient.invalidateQueries({
      exact: true,
      queryKey: authorizedSpacesQueryKey,
    });
  }, [organizationId, queryClient, runtimeNotFound, spaceId]);

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
    isApiProblem(spacesQuery.error, "unauthenticated") ||
    isApiProblem(runtimeQuery.error, "unauthenticated")
  ) {
    return <SessionRedirect returnTo={locationTarget(location)} />;
  }

  const runtimeMatchesRoute =
    runtime?.organizationId === organizationId && runtime.spaceId === spaceId;
  const role = runtime && runtimeMatchesRoute && currentSpace && !currentSessionFailure
    ? runtime.role
    : null;
  const readyBootstrap =
    isReadySpaceRuntime(runtime) &&
    runtimeMatchesRoute &&
    currentSpace &&
    !currentSessionFailure
      ? runtime
      : null;
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
      onOpenSpaceGraph={readyBootstrap ? openSpaceGraph : null}
      onOpenSpaceSearch={readyBootstrap ? openSpaceSearch : null}
      onLogout={() => logoutMutation.mutate()}
      role={role}
      spaces={spaces}
    >
      <SpaceSessionRoot
        bootstrap={readyBootstrap}
        createProtyleMenuSurface={createProtyleMenuSurface}
        onAccessLost={handleSessionAccessLost}
        onHostEvent={handleHostEvent}
        retryRuntime={retrySessionRuntime}
      >
        {(composition) => {
          compositionRef.current = composition;
          if (!readyBootstrap) {
            return content;
          }
          if (!isCurrentSpaceComposition(composition, readyBootstrap)) {
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
              identity={readyBootstrap}
              navigationCommand={
                navigationCommand?.spaceId === readyBootstrap.spaceId
                  ? navigationCommand
                  : null
              }
              onDirectoryAccessLost={handleDirectoryAccessLost}
              onDirectoryStatusChange={setDirectoryStatus}
              onDiscoveryNavigate={handleDiscoveryNavigate}
              onNavigationCommandComplete={completeNavigationCommand}
              readOnly={readyBootstrap.role === "viewer"}
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
