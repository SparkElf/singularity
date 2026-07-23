import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DocumentGovernancePanel } from "@/enterprise/DocumentGovernancePanel.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const NOTEBOOK_ID = "20260723090000-l4book1";
const DOCUMENT_A = "20260723090001-l4doc01";
const DOCUMENT_B = "20260723090002-l4doc02";
const CSRF_TOKEN = "A".repeat(42) + "E";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function identity(documentId: string) {
  return {
    documentId,
    notebookId: NOTEBOOK_ID,
    organizationId: ORGANIZATION_ID,
    spaceId: SPACE_ID,
  } as const;
}

function governance(documentId: string) {
  return {
    classification: "internal",
    document: identity(documentId),
    legalHold: false,
    lifecycle: "draft",
    verification: "needs-review",
  };
}

function queryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DocumentGovernancePanel", () => {
  test("requests governance data with all four document identity fields", async () => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      requests.push(url);
      if (url.pathname.endsWith("/governance/approvals")) return Promise.resolve(jsonResponse({ approvals: [] }));
      if (url.pathname.endsWith("/governance/embeds")) return Promise.resolve(jsonResponse({ embeds: [] }));
      return Promise.resolve(jsonResponse(governance(DOCUMENT_A)));
    }));

    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <DocumentGovernancePanel identity={identity(DOCUMENT_A)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("文档治理")).toBeVisible();
    await waitFor(() => expect(requests.some((request) => request.pathname === `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_A}/governance`)).toBe(true));
  });

  test("does not render a late AI response after the document scope changes", async () => {
    let resolveAi: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (url.pathname === "/api/v1/auth/csrf") return Promise.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
      if (url.pathname.endsWith("/ai-chat")) return new Promise<Response>((resolve) => { resolveAi = resolve; });
      if (url.pathname.endsWith("/governance/approvals")) return Promise.resolve(jsonResponse({ approvals: [] }));
      if (url.pathname.endsWith("/governance/embeds")) return Promise.resolve(jsonResponse({ embeds: [] }));
      const documentId = url.pathname.endsWith(`/${DOCUMENT_B}/governance`) ? DOCUMENT_B : DOCUMENT_A;
      return Promise.resolve(jsonResponse(governance(documentId)));
    }));

    const client = queryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DocumentGovernancePanel identity={identity(DOCUMENT_A)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("文档治理")).toBeVisible();
    fireEvent.change(screen.getByLabelText("AI 问题"), { target: { value: "旧文档问题" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DocumentGovernancePanel identity={identity(DOCUMENT_B)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(resolveAi).toBeDefined());
    resolveAi?.(jsonResponse({ answer: "旧回答", citations: [{ document: identity(DOCUMENT_A), excerpt: "旧引用" }], conversationId: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444" }));
    await waitFor(() => expect(screen.queryByText("旧回答")).not.toBeInTheDocument());
  });

  test("renders a sandboxed embed preview and exposes an identity-bound citation target", async () => {
    const navigate = vi.fn();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (url.pathname === "/api/v1/auth/csrf") return Promise.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
      if (url.pathname.endsWith("/governance/approvals")) return Promise.resolve(jsonResponse({ approvals: [] }));
      if (url.pathname.endsWith("/governance/embeds")) return Promise.resolve(jsonResponse({ embeds: [{ embedId: "55555555-5555-4555-8555-555555555555", kind: "drawio", payload: { previewUrl: "https://app.diagrams.net/" }, status: "active", version: 2 }] }));
      if (url.pathname.endsWith("/ai-chat")) return Promise.resolve(jsonResponse({ answer: "已找到", citations: [{ document: identity(DOCUMENT_A), excerpt: "可追溯引用" }], conversationId: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444" }));
      return Promise.resolve(jsonResponse(governance(DOCUMENT_A)));
    }));

    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <DocumentGovernancePanel identity={identity(DOCUMENT_A)} onNavigateCitation={navigate} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTitle("drawio 嵌入预览")).toHaveAttribute("sandbox", "allow-scripts");
    fireEvent.change(screen.getByLabelText("AI 问题"), { target: { value: "查找" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await screen.findByText("已找到");
    fireEvent.click(screen.getByRole("button", { name: `打开引用 ${DOCUMENT_A}` }));
    expect(navigate).toHaveBeenCalledWith(identity(DOCUMENT_A));
  });
});
