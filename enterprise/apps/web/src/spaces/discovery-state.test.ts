import { afterEach, describe, expect, it } from "vitest";

import { useDiscoveryStore } from "@/spaces/discovery-state.ts";

const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTEBOOK_A = "20260718000000-noteb01";
const DOCUMENT_A = "20260718000100-docum01";

afterEach(() => {
  useDiscoveryStore.setState({ panel: null, requestRevision: 0 });
});

describe("discovery host-event state", () => {
  it("keeps space search scoped to bootstrap space and applies toggle-term without content inference", () => {
    useDiscoveryStore.getState().openSpaceSearch({
      method: "preferred",
      query: "alpha",
      queryMode: "replace",
      spaceId: SPACE_A,
    });
    useDiscoveryStore.getState().openSpaceSearch({
      method: "preferred",
      query: "beta",
      queryMode: "toggle-term",
      spaceId: SPACE_A,
    });

    expect(useDiscoveryStore.getState().panel).toEqual({
      kind: "space-search",
      method: "preferred",
      query: "alpha beta",
      spaceId: SPACE_A,
    });
    expect(useDiscoveryStore.getState().panel).not.toHaveProperty("notebookId");
    expect(useDiscoveryStore.getState().panel).not.toHaveProperty("documentId");
  });

  it("toggles a multi-word tag as one search term", () => {
    useDiscoveryStore.getState().openSpaceSearch({
      method: "keyword",
      query: "#design system#",
      queryMode: "replace",
      spaceId: SPACE_A,
    });
    useDiscoveryStore.getState().openSpaceSearch({
      method: "keyword",
      query: "#release notes#",
      queryMode: "toggle-term",
      spaceId: SPACE_A,
    });
    expect(useDiscoveryStore.getState().panel).toMatchObject({
      query: "#design system# #release notes#",
    });

    useDiscoveryStore.getState().openSpaceSearch({
      method: "keyword",
      query: "#design system#",
      queryMode: "toggle-term",
      spaceId: SPACE_A,
    });
    expect(useDiscoveryStore.getState().panel).toMatchObject({
      query: "#release notes#",
    });
  });

  it("refreshes only the exact document panel identity", () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_A,
      kind: "backlinks",
      notebookId: NOTEBOOK_A,
      spaceId: SPACE_A,
    });
    const before = useDiscoveryStore.getState().requestRevision;

    useDiscoveryStore.getState().refreshDocumentPanel({
      documentId: DOCUMENT_A,
      kind: "backlinks",
      notebookId: NOTEBOOK_A,
      spaceId: SPACE_B,
    });
    expect(useDiscoveryStore.getState().requestRevision).toBe(before);

    useDiscoveryStore.getState().refreshDocumentPanel({
      documentId: DOCUMENT_A,
      kind: "backlinks",
      notebookId: NOTEBOOK_A,
      spaceId: SPACE_A,
    });
    expect(useDiscoveryStore.getState().requestRevision).toBe(before + 1);
  });

  it("does not close a panel owned by another space", () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_A,
      kind: "outline",
      notebookId: NOTEBOOK_A,
      preview: false,
      spaceId: SPACE_A,
    });

    useDiscoveryStore.getState().close(SPACE_B);
    expect(useDiscoveryStore.getState().panel?.spaceId).toBe(SPACE_A);

    useDiscoveryStore.getState().close(SPACE_A);
    expect(useDiscoveryStore.getState().panel).toBeNull();
  });

  it("resets the previous route panel without depending on the next space identity", () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_A,
      kind: "outline",
      notebookId: NOTEBOOK_A,
      preview: false,
      spaceId: SPACE_A,
    });
    const before = useDiscoveryStore.getState().requestRevision;

    useDiscoveryStore.getState().reset();

    expect(useDiscoveryStore.getState().panel).toBeNull();
    expect(useDiscoveryStore.getState().requestRevision).toBe(before + 1);
  });
});
