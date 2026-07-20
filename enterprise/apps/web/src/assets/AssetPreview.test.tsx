import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfPreview = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("@/assets/PdfCanvasPreview.tsx", () => ({
  PdfCanvasPreview: (props: {
    readonly data: Uint8Array;
    readonly initialPage?: number | string;
  }) => {
    pdfPreview.render(props);
    return <div data-testid="pdf-canvas-preview" />;
  },
}));

import { AssetPreview } from "@/assets/AssetPreview.tsx";

const PREVIEW_URL = "/api/v1/organizations/org/spaces/space/assets/file.bin";
const DOWNLOAD_URL = `${PREVIEW_URL}?download=true`;
const fetchMock = vi.fn<typeof fetch>();
const createObjectURL = vi.fn(() => "blob:singularity-preview");
const revokeObjectURL = vi.fn();

const response = (
  body: BodyInit,
  mediaType: string,
  fileName: string,
): Response => new Response(body, {
  headers: {
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Type": mediaType,
  },
  status: 200,
});

describe("AssetPreview", () => {
  let originalCreateObjectURL: PropertyDescriptor | undefined;
  let originalRevokeObjectURL: PropertyDescriptor | undefined;

  beforeEach(() => {
    fetchMock.mockReset();
    createObjectURL.mockReset();
    createObjectURL.mockReturnValue("blob:singularity-preview");
    revokeObjectURL.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    pdfPreview.render.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
    } else {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
    } else {
      delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it("renders only an inert image through a Blob URL", async () => {
    fetchMock.mockResolvedValue(response(new Uint8Array([1, 2, 3]), "image/png", "diagram.png"));

    const { unmount } = render(
      <AssetPreview downloadSrc={DOWNLOAD_URL} src={PREVIEW_URL} />,
    );

    const image = await screen.findByRole("img", { name: "diagram.png" });
    expect(image).toHaveAttribute("src", "blob:singularity-preview");
    expect(document.querySelector("iframe, object, embed, script")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      PREVIEW_URL,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        method: "GET",
        mode: "same-origin",
        redirect: "error",
      }),
    );

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:singularity-preview");
  });

  it("forces active content to the download route without creating an executable element", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(response(
      "<script>window.__activeContentExecuted = true</script>",
      "text/html",
      "unsafe.html",
    ));

    render(
      <AssetPreview downloadSrc={DOWNLOAD_URL} src={PREVIEW_URL} />,
    );

    await waitFor(() => expect(screen.getByText("该附件需要下载后使用")).toBeVisible());
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector("iframe, object, embed, script")).toBeNull();
    expect((window as Window & { __activeContentExecuted?: boolean }).__activeContentExecuted)
      .toBeUndefined();
    expect(screen.getByRole("link", { name: "下载文件" })).toHaveAttribute(
      "href",
      DOWNLOAD_URL,
    );
  });

  it("passes authorized PDF bytes to the canvas renderer and keeps the download explicit", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    fetchMock.mockResolvedValue(response(bytes, "application/pdf", "manual.pdf"));

    render(
      <AssetPreview
        downloadSrc={DOWNLOAD_URL}
        initialPage="2"
        src={PREVIEW_URL}
      />,
    );

    expect(await screen.findByTestId("pdf-canvas-preview")).toBeVisible();
    expect(pdfPreview.render).toHaveBeenCalledWith({
      data: bytes,
      initialPage: "2",
    });
    expect(document.querySelector("iframe, object, embed")).toBeNull();
    expect(screen.getByRole("link", { name: "下载 PDF" })).toHaveAttribute(
      "href",
      DOWNLOAD_URL,
    );
  });

  it("records the original request error before showing the unavailable state", async () => {
    const failure = new Error("asset transport unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockRejectedValue(failure);

    render(<AssetPreview downloadSrc={DOWNLOAD_URL} src={PREVIEW_URL} />);

    expect(await screen.findByText("附件无法加载")).toBeVisible();
    expect(consoleError).toHaveBeenCalledWith(
      "[asset.preview]",
      { operation: "fetch", result: "failed" },
      failure,
    );
    expect(failure.stack).toMatch(/Error: asset transport unavailable\n\s+at /);
  });
});
