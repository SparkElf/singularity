import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import type { ProtyleSession } from "@singularity/protyle-browser";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileClockIcon,
  GitForkIcon,
  ListTreeIcon,
  RefreshCwIcon,
  SearchIcon,
  TextSearchIcon,
  XIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  createSpaceDiscoveryClient,
  loadDocumentBacklinks,
  loadDocumentGraph,
  loadDocumentHistory,
  loadDocumentOutline,
  searchDocument,
  type DiscoveryBacklinkItem,
  type DiscoveryGraphNode,
  type DiscoveryGraphResult,
  type DiscoveryOutlineItem,
  type DiscoverySearchResult,
  type SpaceDiscoveryClient,
} from "@/spaces/discovery-api.ts";
import {
  type BacklinksPanel,
  type DiscoveryPanel,
  type DocumentGraphPanel,
  type DocumentHistoryPanel,
  type DocumentSearchPanel,
  type OutlinePanel,
  type SpaceGraphPanel,
  type SpaceSearchPanel,
  useDiscoveryStore,
} from "@/spaces/discovery-state.ts";
import { useContentSelectionStore } from "@/spaces/content-selection.ts";
import type { SpaceProtyleRuntime } from "@/spaces/space-session.ts";

export interface DiscoveryNavigationTarget {
  readonly blockId: string;
  readonly documentId: string;
  readonly notebookId: string;
}

interface DiscoveryPanelProps {
  readonly organizationId: string;
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
  readonly spaceId: string;
}

type RequestState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly data: T; readonly status: "ready" };

function useDiscoveryRequest<T>(input: {
  readonly diagnostic: {
    readonly documentId?: string;
    readonly kind: DiscoveryPanel["kind"];
    readonly notebookId?: string;
    readonly spaceId: string;
  };
  readonly enabled: boolean;
  readonly load: (signal: AbortSignal) => Promise<T>;
  readonly requestRevision: number;
}): RequestState<T> {
  const [state, setState] = useState<RequestState<T>>({ status: "idle" });
  const loadCurrent = useEffectEvent(input.load);
  const enabledCurrent = useEffectEvent(() => input.enabled);
  const {
    documentId,
    kind,
    notebookId,
    spaceId,
  } = input.diagnostic;

  useEffect(() => {
    if (!enabledCurrent()) {
      // 关闭面板时立即撤销旧请求状态，避免旧结果重新显示。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    let acceptsResult = true;
    // 请求代次变化时先清除旧结果，再接收当前请求的响应。
    setState({ status: "loading" });
    loadCurrent(controller.signal).then((data) => {
      if (acceptsResult) {
        setState({ data, status: "ready" });
      }
    }).catch((error: unknown) => {
      if (!acceptsResult || controller.signal.aborted) {
        return;
      }
      console.error("[discovery.panel]", {
        documentId,
        error,
        kind,
        notebookId,
        outcome: "request-failed",
        spaceId,
      });
      setState({ status: "error" });
    });
    return () => {
      acceptsResult = false;
      controller.abort(new DOMException("Discovery panel changed", "AbortError"));
    };
  }, [documentId, input.enabled, kind, notebookId, spaceId, input.requestRevision]);

  return state;
}

function panelTitle(panel: DiscoveryPanel): string {
  switch (panel.kind) {
    case "space-search":
      return "空间搜索";
    case "document-search":
      return "文档内搜索";
    case "outline":
      return "文档大纲";
    case "backlinks":
      return "反向链接";
    case "document-history":
      return "文档历史";
    case "space-graph":
      return "空间关系图";
    case "document-graph":
      return "文档关系图";
  }
}

function panelIcon(panel: DiscoveryPanel) {
  switch (panel.kind) {
    case "space-search":
      return <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
    case "document-search":
      return <TextSearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
    case "outline":
      return <ListTreeIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
    case "backlinks":
      return <GitForkIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
    case "document-history":
      return <FileClockIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
    case "space-graph":
    case "document-graph":
      return <GitForkIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
  }
}

function PanelState({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function LoadingState() {
  return (
    <PanelState>
      <span className="flex items-center gap-2">
        <Spinner aria-label="正在读取内容" />
        正在读取
      </span>
    </PanelState>
  );
}

function ErrorState() {
  const refresh = useDiscoveryStore((state) => state.refresh);
  return (
    <div className="p-3">
      <Alert variant="destructive">
        <AlertTitle>无法读取</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          内容服务没有返回可用结果。
          <Button onClick={refresh} size="sm" variant="outline">
            <RefreshCwIcon aria-hidden="true" />
            重试
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

function SearchResults({
  onNavigate,
  result,
}: {
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly result: DiscoverySearchResult;
}) {
  if (result.blocks.length === 0) {
    return <PanelState>没有匹配内容</PanelState>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
        <span>{result.matchedBlockCount} 个匹配块</span>
        <span>{result.pageCount} 页</span>
      </div>
      <ul className="space-y-0.5">
        {result.blocks.map((block) => (
          <li key={`${block.notebookId}:${block.id}`}>
            <button
              className="flex min-h-10 w-full min-w-0 flex-col items-start justify-center rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => onNavigate({
                blockId: block.id,
                documentId: block.documentId,
                notebookId: block.notebookId,
              })}
              type="button"
            >
              <span className="line-clamp-2 w-full text-sm">
                {block.content || "无文本内容"}
              </span>
              <span className="mt-0.5 max-w-full truncate text-xs text-muted-foreground">
                {block.documentId}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SearchPanelBody({
  onNavigate,
  panel,
  requestRevision,
  session,
  spaceClient,
}: {
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly panel: SpaceSearchPanel | DocumentSearchPanel;
  readonly requestRevision: number;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
  readonly spaceClient: SpaceDiscoveryClient;
}) {
  const setQuery = useDiscoveryStore((state) => state.setQuery);
  const submitQuery = useDiscoveryStore((state) => state.submitQuery);
  const load = useCallback((signal: AbortSignal) => {
    if (panel.kind === "space-search") {
      return spaceClient.search({
        method: panel.method,
        query: panel.query,
        signal,
      });
    }
    return searchDocument({
      documentId: panel.documentId,
      notebookId: panel.notebookId,
      query: panel.query,
      signal,
      transport: session.runtime.transport,
    });
  }, [panel, session.runtime.transport, spaceClient]);
  const diagnostic = useMemo(() => ({
    ...(panel.kind === "document-search"
      ? { documentId: panel.documentId, notebookId: panel.notebookId }
      : {}),
    kind: panel.kind,
    spaceId: panel.spaceId,
  }), [panel]);
  const state = useDiscoveryRequest({
    diagnostic,
    enabled: panel.query.trim() !== "",
    load,
    requestRevision,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitQuery();
  };

  return (
    <>
      <form className="flex gap-1.5 border-b p-2" onSubmit={submit}>
        <Input
          aria-label={panel.kind === "space-search" ? "搜索当前空间" : "搜索当前文档"}
          autoFocus
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={panel.kind === "space-search" ? "搜索当前空间" : "搜索当前文档"}
          type="search"
          value={panel.query}
        />
        <Button aria-label="执行搜索" size="icon" type="submit">
          <SearchIcon aria-hidden="true" />
        </Button>
      </form>
      {state.status === "idle" ? <PanelState>输入关键词开始搜索</PanelState> : null}
      {state.status === "loading" ? <LoadingState /> : null}
      {state.status === "error" ? <ErrorState /> : null}
      {state.status === "ready" ? (
        <SearchResults onNavigate={onNavigate} result={state.data} />
      ) : null}
    </>
  );
}

function OutlineItems({
  items,
  onNavigate,
  panel,
}: {
  readonly items: readonly DiscoveryOutlineItem[];
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly panel: OutlinePanel;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <button
            className="min-h-8 w-full min-w-0 truncate rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => onNavigate({
              blockId: item.id,
              documentId: panel.documentId,
              notebookId: panel.notebookId,
            })}
            title={item.name}
            type="button"
          >
            {item.name}
          </button>
          {item.children.length > 0 ? (
            <div className="pl-3">
              <OutlineItems items={item.children} onNavigate={onNavigate} panel={panel} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function OutlinePanelBody({
  onNavigate,
  panel,
  requestRevision,
  session,
}: {
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly panel: OutlinePanel;
  readonly requestRevision: number;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
}) {
  const load = useCallback((signal: AbortSignal) => loadDocumentOutline({
    documentId: panel.documentId,
    notebookId: panel.notebookId,
    preview: panel.preview,
    signal,
    transport: session.runtime.transport,
  }), [panel, session.runtime.transport]);
  const diagnostic = useMemo(() => ({
    documentId: panel.documentId,
    kind: panel.kind,
    notebookId: panel.notebookId,
    spaceId: panel.spaceId,
  }), [panel]);
  const state = useDiscoveryRequest({
    diagnostic,
    enabled: true,
    load,
    requestRevision,
  });
  if (state.status === "loading" || state.status === "idle") {
    return <LoadingState />;
  }
  if (state.status === "error") {
    return <ErrorState />;
  }
  if (state.data.length === 0) {
    return <PanelState>当前文档没有大纲项</PanelState>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <OutlineItems items={state.data} onNavigate={onNavigate} panel={panel} />
    </div>
  );
}

function BacklinkList({
  items,
  label,
  onNavigate,
}: {
  readonly items: readonly DiscoveryBacklinkItem[];
  readonly label: string;
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
}) {
  return (
    <section aria-label={label} className="py-1">
      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">暂无内容</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={`${item.notebookId}:${item.documentId}`}>
              <button
                className="min-h-9 w-full min-w-0 truncate rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => onNavigate({
                  blockId: item.documentId,
                  documentId: item.documentId,
                  notebookId: item.notebookId,
                })}
                title={item.title}
                type="button"
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BacklinksPanelBody({
  onNavigate,
  panel,
  requestRevision,
  session,
}: {
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly panel: BacklinksPanel;
  readonly requestRevision: number;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
}) {
  const load = useCallback((signal: AbortSignal) => loadDocumentBacklinks({
    documentId: panel.documentId,
    notebookId: panel.notebookId,
    signal,
    transport: session.runtime.transport,
  }), [panel, session.runtime.transport]);
  const diagnostic = useMemo(() => ({
    documentId: panel.documentId,
    kind: panel.kind,
    notebookId: panel.notebookId,
    spaceId: panel.spaceId,
  }), [panel]);
  const state = useDiscoveryRequest({
    diagnostic,
    enabled: true,
    load,
    requestRevision,
  });
  if (state.status === "loading" || state.status === "idle") {
    return <LoadingState />;
  }
  if (state.status === "error") {
    return <ErrorState />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <BacklinkList items={state.data.backlinks} label="反向链接" onNavigate={onNavigate} />
      <BacklinkList items={state.data.backmentions} label="提及" onNavigate={onNavigate} />
    </div>
  );
}

function formatHistoryTime(value: string): string {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return value;
  }
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function HistoryPanelBody({
  panel,
  requestRevision,
  session,
}: {
  readonly panel: DocumentHistoryPanel;
  readonly requestRevision: number;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
}) {
  const setHistoryPage = useDiscoveryStore((state) => state.setHistoryPage);
  const load = useCallback((signal: AbortSignal) => loadDocumentHistory({
    documentId: panel.documentId,
    notebookId: panel.notebookId,
    page: panel.page,
    signal,
    transport: session.runtime.transport,
  }), [panel, session.runtime.transport]);
  const diagnostic = useMemo(() => ({
    documentId: panel.documentId,
    kind: panel.kind,
    notebookId: panel.notebookId,
    spaceId: panel.spaceId,
  }), [panel]);
  const state = useDiscoveryRequest({
    diagnostic,
    enabled: true,
    load,
    requestRevision,
  });
  if (state.status === "loading" || state.status === "idle") {
    return <LoadingState />;
  }
  if (state.status === "error") {
    return <ErrorState />;
  }
  return (
    <>
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <Button
          aria-label="上一页历史"
          disabled={panel.page <= 1}
          onClick={() => setHistoryPage(panel.page - 1)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <span className="text-xs text-muted-foreground">
          第 {panel.page} / {Math.max(1, state.data.pageCount)} 页，共 {state.data.totalCount} 条
        </span>
        <Button
          aria-label="下一页历史"
          disabled={panel.page >= state.data.pageCount}
          onClick={() => setHistoryPage(panel.page + 1)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
      {state.data.histories.length === 0 ? (
        <PanelState>当前文档没有历史记录</PanelState>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {state.data.histories.map((createdAt, index) => (
            <li className="min-h-9 rounded-md px-2 py-2 text-sm" key={`${createdAt}:${index}`}>
              {formatHistoryTime(createdAt)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function GraphCanvas({ graph }: { readonly graph: DiscoveryGraphResult }) {
  const nodes = graph.nodes.slice(0, 48);
  const positions = new Map<string, { readonly x: number; readonly y: number }>();
  const center = 160;
  const radius = nodes.length <= 1 ? 0 : 122;
  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length) - Math.PI / 2;
    positions.set(node.id, {
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
    });
  });
  const links = graph.links.filter((link) =>
    positions.has(link.from) && positions.has(link.to)
  );
  return (
    <svg
      aria-label={`${nodes.length} 个节点，${links.length} 条关系`}
      className="aspect-square w-full max-w-[22rem]"
      role="img"
      viewBox="0 0 320 320"
    >
      {links.map((link, index) => {
        const from = positions.get(link.from)!;
        const to = positions.get(link.to)!;
        return (
          <line
            key={`${link.from}:${link.to}:${index}`}
            stroke="var(--border)"
            strokeWidth="1.5"
            x1={from.x}
            x2={to.x}
            y1={from.y}
            y2={to.y}
          />
        );
      })}
      {nodes.map((node) => {
        const position = positions.get(node.id)!;
        return (
          <g key={node.id}>
            <circle
              cx={position.x}
              cy={position.y}
              fill="var(--accent)"
              r="7"
              stroke="var(--primary)"
              strokeWidth="1.5"
            />
            <title>{node.label}</title>
          </g>
        );
      })}
    </svg>
  );
}

function GraphNodeList({
  nodes,
  onNavigate,
}: {
  readonly nodes: readonly DiscoveryGraphNode[];
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
}) {
  return (
    <ul className="border-t p-2">
      {nodes.slice(0, 48).map((node) => (
        <li key={node.id}>
          {node.documentId !== null && node.notebookId !== null ? (
            <button
              className="min-h-8 w-full min-w-0 truncate rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => {
                const documentId = node.documentId;
                const notebookId = node.notebookId;
                if (documentId === null || notebookId === null) {
                  return;
                }
                onNavigate({ blockId: node.id, documentId, notebookId });
              }}
              title={node.label}
              type="button"
            >
              {node.label}
            </button>
          ) : (
            <span
              className="block min-h-8 w-full min-w-0 truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground"
              title={node.label}
            >
              {node.label}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function GraphPanelBody({
  enabled,
  onNavigate,
  panel,
  requestRevision,
  session,
  spaceClient,
}: {
  readonly enabled: boolean;
  readonly onNavigate: (target: DiscoveryNavigationTarget) => void;
  readonly panel: SpaceGraphPanel | DocumentGraphPanel;
  readonly requestRevision: number;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
  readonly spaceClient: SpaceDiscoveryClient;
}) {
  const setQuery = useDiscoveryStore((state) => state.setQuery);
  const submitQuery = useDiscoveryStore((state) => state.submitQuery);
  const load = useCallback((signal: AbortSignal) => {
    if (panel.kind === "space-graph") {
      return spaceClient.graph({ query: panel.query, signal });
    }
    return loadDocumentGraph({
      documentId: panel.documentId,
      notebookId: panel.notebookId,
      query: panel.query,
      signal,
      transport: session.runtime.transport,
    });
  }, [panel, session.runtime.transport, spaceClient]);
  const diagnostic = useMemo(() => ({
    ...(panel.kind === "document-graph"
      ? { documentId: panel.documentId, notebookId: panel.notebookId }
      : {}),
    kind: panel.kind,
    spaceId: panel.spaceId,
  }), [panel]);
  const state = useDiscoveryRequest({
    diagnostic,
    enabled,
    load,
    requestRevision,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitQuery();
  };
  return (
    <>
      <form className="flex gap-1.5 border-b p-2" onSubmit={submit}>
        <Input
          aria-label="筛选关系图"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="筛选节点"
          type="search"
          value={panel.query}
        />
        <Button aria-label="应用关系图筛选" size="icon" type="submit">
          <SearchIcon aria-hidden="true" />
        </Button>
      </form>
      {!enabled ? <PanelState>当前文档无法显示关系图</PanelState> : null}
      {enabled && (state.status === "loading" || state.status === "idle")
        ? <LoadingState />
        : null}
      {enabled && state.status === "error" ? <ErrorState /> : null}
      {enabled && state.status === "ready" && state.data.nodes.length === 0 ? (
        <PanelState>没有可显示的关系</PanelState>
      ) : null}
      {enabled && state.status === "ready" && state.data.nodes.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex justify-center p-2">
            <GraphCanvas graph={state.data} />
          </div>
          <GraphNodeList nodes={state.data.nodes} onNavigate={onNavigate} />
        </div>
      ) : null}
    </>
  );
}

export function DiscoveryPanel({
  onNavigate,
  organizationId,
  session,
  spaceId,
}: DiscoveryPanelProps) {
  const panel = useDiscoveryStore((state) =>
    state.panel?.spaceId === spaceId ? state.panel : null
  );
  const documentGraphEnabled = useContentSelectionStore((state) => {
    if (panel?.kind !== "document-graph") {
      return false;
    }
    const selection = state.selection;
    return selection?.spaceId === panel.spaceId &&
      selection.notebookId === panel.notebookId &&
      selection.documentId === panel.documentId &&
      selection.supportsGraph;
  });
  const requestRevision = useDiscoveryStore((state) => state.requestRevision);
  const close = useDiscoveryStore((state) => state.close);
  const refresh = useDiscoveryStore((state) => state.refresh);
  const spaceClient = useMemo(() => createSpaceDiscoveryClient({
    organizationId,
    onRuntimeError: session.runtime.host.dispatch,
    spaceId,
  }), [organizationId, session.runtime.host.dispatch, spaceId]);

  if (!panel || session.spaceId !== spaceId) {
    return null;
  }
  const icon = panelIcon(panel);
  return (
    <aside
      aria-label={panelTitle(panel)}
      className="flex min-h-0 w-[21rem] shrink-0 flex-col border-l bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:w-[min(100%,24rem)] max-lg:shadow-lg"
      data-discovery-kind={panel.kind}
      data-discovery-space-id={panel.spaceId}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        {icon}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {panelTitle(panel)}
        </h2>
        <Button
          aria-label="刷新面板"
          onClick={refresh}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon aria-hidden="true" />
        </Button>
        <Button
          aria-label="关闭面板"
          onClick={() => close(spaceId)}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      {panel.kind === "space-search" || panel.kind === "document-search" ? (
        <SearchPanelBody
          onNavigate={onNavigate}
          panel={panel}
          requestRevision={requestRevision}
          session={session}
          spaceClient={spaceClient}
        />
      ) : null}
      {panel.kind === "outline" ? (
        <OutlinePanelBody
          onNavigate={onNavigate}
          panel={panel}
          requestRevision={requestRevision}
          session={session}
        />
      ) : null}
      {panel.kind === "backlinks" ? (
        <BacklinksPanelBody
          onNavigate={onNavigate}
          panel={panel}
          requestRevision={requestRevision}
          session={session}
        />
      ) : null}
      {panel.kind === "document-history" ? (
        <HistoryPanelBody
          panel={panel}
          requestRevision={requestRevision}
          session={session}
        />
      ) : null}
      {panel.kind === "space-graph" || panel.kind === "document-graph" ? (
        <GraphPanelBody
          enabled={panel.kind === "space-graph" || documentGraphEnabled}
          onNavigate={onNavigate}
          panel={panel}
          requestRevision={requestRevision}
          session={session}
          spaceClient={spaceClient}
        />
      ) : null}
    </aside>
  );
}
