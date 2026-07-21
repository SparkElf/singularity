import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/collaboration/CollaborationPanel.tsx";

const identity = {
  documentId: "20260721090001-docabcd",
  notebookId: "20260721090000-bookabc",
  organizationId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
};

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CollaborationPanel", () => {
  it("keeps the selected document identity visible while loading its server state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = new URL(String(input), window.location.origin).pathname;
        if (path.endsWith("/notifications/unread-count")) {
          return Promise.resolve(new Response(JSON.stringify({ unreadCount: 0 }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ cursor: null, threads: [] }), { status: 200 }));
      }),
    );

    render(
      <QueryClientProvider client={queryClient()}>
        <CollaborationPanel identity={identity} />
      </QueryClientProvider>,
    );

    expect(screen.getByText(identity.documentId)).toBeInTheDocument();
    expect(await screen.findByText("当前文档还没有评论。")).toBeInTheDocument();
  });
});
