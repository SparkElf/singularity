import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthIdentity } from "../auth/types";
import { DocumentGovernancePanel } from "./DocumentGovernancePanel";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000501";
const SPACE_ID = "00000000-0000-4000-8000-000000000502";
const DOCUMENT_A = "20260713000000-a1b2c3d";
const CSRF_TOKEN = "csrf-token";

function identity(documentId: string): AuthIdentity {
  return {
    sessionId: "00000000-0000-4000-8000-000000000503",
    user: { id: "00000000-0000-4000-8000-000000000504", username: "governor" },
    organization: { id: ORGANIZATION_ID, slug: "governance", name: "Governance" },
    space: { id: SPACE_ID, slug: "knowledge", name: "Knowledge", role: "owner" },
    capabilities: {
      canRead: true,
      canWrite: true,
      canShare: true,
      canAdminister: true,
    },
    permissions: ["space:read", "space:write", "space:share", "space:admin"],
    documentId,
  };
}

function governance(documentId: string) {
  return {
    documentId,
    retention: { policy: "keep", updatedAt: null },
    approvals: [],
    embeds: [],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DocumentGovernancePanel", () => {
  it("loads governance state and updates retention", async () => {
    const requests: Array<{ body: unknown; method: string; url: URL }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://singularity.invalid");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ body, method, url });
      if (url.pathname === "/api/v1/auth/csrf") return Promise.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
      if (url.pathname.endsWith("/governance/approvals")) return Promise.resolve(jsonResponse({ approvals: [] }));
      if (url.pathname.endsWith("/governance/embeds")) return Promise.resolve(jsonResponse({ embeds: [] }));
      if (method === "PUT") return Promise.resolve(jsonResponse({ ...governance(DOCUMENT_A), retention: { policy: "archive", updatedAt: "2026-07-13T00:00:00.000Z" } }));
      return Promise.resolve(jsonResponse(governance(DOCUMENT_A)));
    }));

    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <DocumentGovernancePanel identity={identity(DOCUMENT_A)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText("文档治理");
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PUT")).toBe(true));
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ policy: "archive" });
  });

  it("requests approval with CSRF protection", async () => {
    const requests: Array<{ body: unknown; method: string; url: URL }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://singularity.invalid");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ body, method, url });
      if (url.pathname === "/api/v1/auth/csrf") return Promise.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
      if (url.pathname.endsWith("/governance/approvals") && method === "GET") return Promise.resolve(jsonResponse({ approvals: [] }));
      if (url.pathname.endsWith("/governance/approvals") && method === "POST") return Promise.resolve(jsonResponse({ approvalId: "00000000-0000-4000-8000-000000000505", status: "pending" }, 201));
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

    await screen.findByText("文档治理");
    fireEvent.change(screen.getByLabelText("审批说明"), { target: { value: "发布前复核" } });
    fireEvent.click(screen.getByRole("button", { name: "申请审批" }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST" && request.url.pathname.endsWith("/governance/approvals"))).toBe(true));
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({ reason: "发布前复核" });
  });

  it("accepts drawio save messages only from the registered iframe origin and source", async () => {
    const requests: Array<{ body: unknown; method: string; url: URL }> = [];
    const embedId = "00000000-0000-4000-8000-000000000506";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://singularity.invalid");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ body, method, url });
      if (url.pathname === "/api/v1/auth/csrf") return Promise.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
      if (url.pathname.endsWith("/governance/approvals")) return Promise.resolve(jsonResponse({ approvals: [] }));
      if (url.pathname.endsWith("/governance/embeds") && method === "GET") return Promise.resolve(jsonResponse({ embeds: [{ embedId, kind: "drawio", payload: { editorUrl: "https://app.diagrams.net/" }, status: "active", version: 2 }] }));
      if (url.pathname.endsWith("/governance/embeds") && method === "PUT") return Promise.resolve(jsonResponse({ embedId, kind: "drawio", payload: { saved: true }, status: "active", version: 3 }));
      return Promise.resolve(jsonResponse(governance(DOCUMENT_A)));
    }));

    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <DocumentGovernancePanel identity={identity(DOCUMENT_A)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const iframe = await screen.findByTitle("drawio 嵌入编辑器");
    expect(iframe).toHaveAttribute("sandbox", "allow-forms allow-popups allow-scripts allow-same-origin");
    const saveMessage = { embedId, kind: "drawio", payload: { saved: true }, type: "singularity.embed.save", version: 1 } as const;
    window.dispatchEvent(new MessageEvent("message", { data: saveMessage, origin: "https://app.diagrams.net", source: window }));
    window.dispatchEvent(new MessageEvent("message", { data: { ...saveMessage, kind: "excalidraw" }, origin: "https://app.diagrams.net", source: iframe.contentWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: saveMessage, origin: "https://attacker.example", source: iframe.contentWindow }));
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);

    window.dispatchEvent(new MessageEvent("message", { data: saveMessage, origin: "https://app.diagrams.net", source: iframe.contentWindow }));
    await waitFor(() => expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1));
  });
});
