import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PdfDocument,
  PdfJsRuntime,
  PdfLoadingTask,
  PdfRenderTask,
} from "@/assets/pdfjs-runtime.ts";

const pdfRuntime = vi.hoisted(() => ({
  loadPdfJsRuntime: vi.fn(),
  openPdfDocument: vi.fn(),
}));

vi.mock("@/assets/pdfjs-runtime.ts", () => pdfRuntime);

import { PdfCanvasPreview } from "@/assets/PdfCanvasPreview.tsx";

interface PdfPageFixture {
  readonly getViewport: ReturnType<typeof vi.fn>;
  readonly render: ReturnType<typeof vi.fn>;
}

interface PdfFixture {
  readonly document: PdfDocument;
  readonly loadingTask: PdfLoadingTask;
  readonly page: PdfPageFixture;
  readonly renderTask: PdfRenderTask;
  readonly runtime: PdfJsRuntime;
}

function createPdfFixture(pageCount = 2): PdfFixture {
  const renderTask: PdfRenderTask = {
    cancel: vi.fn(),
    promise: Promise.resolve(),
  };
  const page: PdfPageFixture = {
    getViewport: vi.fn(({ scale }: { readonly scale: number }) => ({
      height: 80 * scale,
      width: 120 * scale,
    })),
    render: vi.fn(() => renderTask),
  };
  const document: PdfDocument = {
    destroy: vi.fn(async () => undefined),
    getPage: vi.fn(async () => page),
    numPages: pageCount,
  };
  const loadingTask: PdfLoadingTask = {
    destroy: vi.fn(async () => undefined),
    promise: Promise.resolve(document),
  };
  const runtime: PdfJsRuntime = {
    getDocument: vi.fn(() => loadingTask),
  };
  return { document, loadingTask, page, renderTask, runtime };
}

describe("PdfCanvasPreview", () => {
  let canvasContext: CanvasRenderingContext2D;

  beforeEach(() => {
    canvasContext = {
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext);
    pdfRuntime.loadPdfJsRuntime.mockReset();
    pdfRuntime.openPdfDocument.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the selected page into a canvas and closes the loading task on unmount", async () => {
    const fixture = createPdfFixture();
    pdfRuntime.loadPdfJsRuntime.mockResolvedValue(fixture.runtime);
    pdfRuntime.openPdfDocument.mockReturnValue(fixture.loadingTask);

    const { unmount } = render(
      <PdfCanvasPreview data={new Uint8Array([1, 2, 3])} initialPage={2} />,
    );

    await waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    const canvas = document.querySelector("[data-pdf-canvas]");
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas).toHaveAttribute("aria-label", "PDF 第 2 页");
    expect(canvas).toHaveAttribute("width", "150");
    expect(canvas).toHaveAttribute("height", "100");
    expect(pdfRuntime.openPdfDocument).toHaveBeenCalledWith(
      fixture.runtime,
      expect.any(Uint8Array),
    );

    unmount();
    expect(fixture.renderTask.cancel).toHaveBeenCalledOnce();
    expect(fixture.loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("changes pages without replacing the PDF document", async () => {
    const fixture = createPdfFixture();
    pdfRuntime.loadPdfJsRuntime.mockResolvedValue(fixture.runtime);
    pdfRuntime.openPdfDocument.mockReturnValue(fixture.loadingTask);

    render(<PdfCanvasPreview data={new Uint8Array([9, 8, 7])} />);
    await waitFor(() => expect(fixture.page.getViewport).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(fixture.page.getViewport).toHaveBeenCalledTimes(2));
    expect(screen.getByText("2 / 2")).toBeVisible();
    expect(pdfRuntime.openPdfDocument).toHaveBeenCalledOnce();
  });
});
