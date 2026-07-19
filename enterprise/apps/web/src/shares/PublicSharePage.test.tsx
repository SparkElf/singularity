import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicSharePage } from "@/shares/PublicSharePage.tsx";

const SHARE_TOKEN = "A".repeat(43);
const ASSET_ID = "a".repeat(64);
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function requestPath(input: RequestInfo | URL): string {
  const url =
    input instanceof Request
      ? new URL(input.url, window.location.origin)
      : new URL(String(input), window.location.origin);
  return url.pathname;
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
}

function renderShare(path: string, queryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/shares/:shareToken" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public document shares", () => {
  it("rejects an invalid route token without issuing an API request", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    renderShare("/shares/invalid");

    expect(
      screen.getByRole("heading", { name: "分享地址无效" }),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a password challenge before rendering the sanitized live document", async () => {
    let documentReads = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/v1/shares/" + SHARE_TOKEN) {
        documentReads += 1;
        if (documentReads === 1) {
          return jsonResponse(
            { code: "unauthenticated", requestId: REQUEST_ID, status: 401 },
            401,
          );
        }
        return jsonResponse({
          assets: [
            {
              assetId: ASSET_ID,
              disposition: "inline",
              fileName: "diagram.png",
              mediaType: "image/png",
            },
          ],
          documentId: "20260718000000-abcdefg",
          html:
            '<p>实时正文</p><img alt="架构图" onerror="window.compromised=true" src="/api/v1/shares/' +
            SHARE_TOKEN +
            "/assets/" +
            ASSET_ID +
            '"><script>window.compromised=true</script><a href="javascript:alert(1)">危险链接</a>' +
            '<a data-document-id="20260718000001-private" href="/organizations/private/spaces/private">内部链接</a>' +
            '<a href="https://docs.example.test/guide">外部链接</a><svg><script>window.compromised=true</script></svg>',
          title: "深空工程手册",
        });
      }
      if (path === "/api/v1/shares/" + SHARE_TOKEN + "/challenge") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({
          password: "correct share password",
        });
        return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected request: " + path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderShare("/shares/" + SHARE_TOKEN);

    expect(
      await screen.findByRole("heading", { name: "此分享需要密码" }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("分享密码"), {
      target: { value: "correct share password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并打开" }));

    expect(
      await screen.findByRole("heading", { name: "深空工程手册" }),
    ).toBeVisible();
    expect(screen.getByText("实时正文")).toBeVisible();
    expect(screen.getByAltText("架构图")).toHaveAttribute(
      "src",
      "/api/v1/shares/" + SHARE_TOKEN + "/assets/" + ASSET_ID,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("危险链接")).not.toHaveAttribute("href");
    expect(screen.getByText("内部链接")).not.toHaveAttribute("href");
    expect(screen.getByText("内部链接")).not.toHaveAttribute(
      "data-document-id",
    );
    expect(screen.getByText("外部链接")).toHaveAttribute(
      "href",
      "https://docs.example.test/guide",
    );
    expect(screen.getByText("外部链接")).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );
    expect(documentReads).toBe(2);
  });

  it("does not render a cached document while the current share state is revalidated", async () => {
    let documentReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        documentReads += 1;
        if (documentReads === 1) {
          return jsonResponse({
            assets: [],
            documentId: "20260718000000-abcdefg",
            html: "<p>即将撤销的正文</p>",
            title: "短期分享",
          });
        }
        return jsonResponse(
          { code: "not-found", requestId: REQUEST_ID, status: 404 },
          404,
        );
      }),
    );

    const queryClient = createTestQueryClient();
    const first = renderShare("/shares/" + SHARE_TOKEN, queryClient);
    expect(await screen.findByText("即将撤销的正文")).toBeVisible();
    first.unmount();

    renderShare("/shares/" + SHARE_TOKEN, queryClient);
    expect(
      await screen.findByRole("heading", { name: "分享不存在或已失效" }),
    ).toBeVisible();
    expect(screen.queryByText("即将撤销的正文")).not.toBeInTheDocument();
    expect(documentReads).toBe(2);
  });

  it("shows a terminal unavailable state for an expired or revoked share", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { code: "not-found", requestId: REQUEST_ID, status: 404 },
          404,
        ),
      ),
    );

    renderShare("/shares/" + SHARE_TOKEN);

    expect(
      await screen.findByRole("heading", {
        name: "分享不存在或已失效",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/链接可能已过期、已撤销/),
    ).toBeVisible();
  });
});
