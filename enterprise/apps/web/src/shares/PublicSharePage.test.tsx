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

function renderShare(path: string) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
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
            '"><script>window.compromised=true</script><a href="javascript:alert(1)">危险链接</a>',
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
    expect(screen.getByText("危险链接")).not.toHaveAttribute("href");
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
