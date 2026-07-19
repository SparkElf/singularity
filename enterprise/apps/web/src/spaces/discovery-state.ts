import type { SpaceDiscoverySearchMethod } from "@singularity/contracts";
import { create } from "zustand";

export type DiscoverySearchMethod = SpaceDiscoverySearchMethod;

export interface SpaceSearchPanel {
  readonly kind: "space-search";
  readonly method: DiscoverySearchMethod;
  readonly query: string;
  readonly spaceId: string;
}

export interface DocumentSearchPanel {
  readonly documentId: string;
  readonly kind: "document-search";
  readonly notebookId: string;
  readonly query: string;
  readonly spaceId: string;
}

export interface OutlinePanel {
  readonly documentId: string;
  readonly kind: "outline";
  readonly notebookId: string;
  readonly preview: boolean;
  readonly spaceId: string;
}

export interface BacklinksPanel {
  readonly documentId: string;
  readonly kind: "backlinks";
  readonly notebookId: string;
  readonly spaceId: string;
}

export interface DocumentHistoryPanel {
  readonly documentId: string;
  readonly kind: "document-history";
  readonly notebookId: string;
  readonly page: number;
  readonly spaceId: string;
}

export interface SpaceGraphPanel {
  readonly kind: "space-graph";
  readonly query: string;
  readonly spaceId: string;
}

export interface DocumentGraphPanel {
  readonly documentId: string;
  readonly kind: "document-graph";
  readonly notebookId: string;
  readonly query: string;
  readonly spaceId: string;
}

export type DiscoveryPanel =
  | SpaceSearchPanel
  | DocumentSearchPanel
  | OutlinePanel
  | BacklinksPanel
  | DocumentHistoryPanel
  | SpaceGraphPanel
  | DocumentGraphPanel;

interface DiscoveryState {
  readonly panel: DiscoveryPanel | null;
  readonly requestRevision: number;
  readonly close: (spaceId: string) => void;
  readonly closeDocumentPanel: (input: {
    readonly documentId: string;
    readonly notebookId: string;
    readonly spaceId: string;
  }) => void;
  readonly open: (panel: DiscoveryPanel) => void;
  readonly openSpaceSearch: (input: {
    readonly method: DiscoverySearchMethod;
    readonly query: string;
    readonly queryMode: "replace" | "toggle-term";
    readonly spaceId: string;
  }) => void;
  readonly refresh: () => void;
  readonly reset: () => void;
  readonly refreshDocumentPanel: (input: {
    readonly documentId: string;
    readonly kind: "backlinks" | "outline";
    readonly notebookId: string;
    readonly spaceId: string;
  }) => void;
  readonly setHistoryPage: (page: number) => void;
  readonly setQuery: (query: string) => void;
  readonly submitQuery: () => void;
}

function toggleTerm(currentQuery: string, term: string): string {
  const normalizedTerm = term.trim();
  if (normalizedTerm === "") {
    return currentQuery;
  }
  const terms = currentQuery.trim() === ""
    ? []
    : currentQuery.trim().split(/\s+/u);
  const index = terms.indexOf(normalizedTerm);
  if (index === -1) {
    terms.push(normalizedTerm);
  } else {
    terms.splice(index, 1);
  }
  return terms.join(" ");
}

function panelSupportsQuery(
  panel: DiscoveryPanel,
): panel is SpaceSearchPanel | DocumentSearchPanel | SpaceGraphPanel | DocumentGraphPanel {
  return panel.kind === "space-search" ||
    panel.kind === "document-search" ||
    panel.kind === "space-graph" ||
    panel.kind === "document-graph";
}

export const useDiscoveryStore = create<DiscoveryState>((set) => ({
  panel: null,
  requestRevision: 0,
  close: (spaceId) => set((state) =>
    state.panel?.spaceId === spaceId
      ? { panel: null, requestRevision: state.requestRevision + 1 }
      : state,
  ),
  closeDocumentPanel: (input) => set((state) => {
    const panel = state.panel;
    if (
      panel === null ||
      panel.spaceId !== input.spaceId ||
      !("documentId" in panel) ||
      panel.notebookId !== input.notebookId ||
      panel.documentId !== input.documentId
    ) {
      return state;
    }
    return { panel: null, requestRevision: state.requestRevision + 1 };
  }),
  open: (panel) => set((state) => ({
    panel,
    requestRevision: state.requestRevision + 1,
  })),
  openSpaceSearch: (input) => set((state) => {
    const currentQuery = state.panel?.kind === "space-search" &&
        state.panel.spaceId === input.spaceId
      ? state.panel.query
      : "";
    const query = input.queryMode === "replace"
      ? input.query
      : toggleTerm(currentQuery, input.query);
    return {
      panel: {
        kind: "space-search",
        method: input.method,
        query,
        spaceId: input.spaceId,
      },
      requestRevision: state.requestRevision + 1,
    };
  }),
  refresh: () => set((state) =>
    state.panel === null
      ? state
      : { requestRevision: state.requestRevision + 1 },
  ),
  reset: () => set((state) => ({
    panel: null,
    requestRevision: state.requestRevision + 1,
  })),
  refreshDocumentPanel: (input) => set((state) => {
    const panel = state.panel;
    if (
      panel?.kind !== input.kind ||
      panel.spaceId !== input.spaceId ||
      panel.notebookId !== input.notebookId ||
      panel.documentId !== input.documentId
    ) {
      return state;
    }
    return { requestRevision: state.requestRevision + 1 };
  }),
  setHistoryPage: (page) => set((state) => {
    if (state.panel?.kind !== "document-history" || page < 1) {
      return state;
    }
    return {
      panel: { ...state.panel, page },
      requestRevision: state.requestRevision + 1,
    };
  }),
  setQuery: (query) => set((state) => {
    if (!state.panel || !panelSupportsQuery(state.panel)) {
      return state;
    }
    return { panel: { ...state.panel, query } };
  }),
  submitQuery: () => set((state) => {
    if (!state.panel || !panelSupportsQuery(state.panel)) {
      return state;
    }
    return { requestRevision: state.requestRevision + 1 };
  }),
}));
