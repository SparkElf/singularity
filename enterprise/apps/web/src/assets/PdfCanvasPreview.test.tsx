import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

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

type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

interface PdfPageFixture extends PdfPage {
  readonly getViewport: Mock<PdfPage["getViewport"]>;
  readonly render: Mock<PdfPage["render"]>;
}

interface PdfFixture {
  readonly document: PdfDocument;
  readonly loadingTask: PdfLoadingTask;
  readonly page: PdfPageFixture;
  readonly renderTask: PdfRenderTask;
  readonly runtime: PdfJsRuntime;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function createPdfFixture(
  pageCount = 2,
  renderPromise: Promise<void> = Promise.resolve(),
): PdfFixture {
  const renderTask: PdfRenderTask = {
    cancel: vi.fn(),
    promise: renderPromise,
  };
  const page: PdfPageFixture = {
    getViewport: vi.fn<PdfPage["getViewport"]>(({ scale }) => ({
      height: 80 * scale,
      width: 120 * scale,
    })),
    render: vi.fn<PdfPage["render"]>(() => renderTask),
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
    const canvas = document.querySelector<HTMLCanvasElement>("[data-pdf-canvas]");
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
    expect(canvas?.width).toBe(0);
    expect(canvas?.height).toBe(0);
    expect(canvas?.style.width).toBe("");
    expect(canvas?.style.height).toBe("");
  });

  it("clears the previous page while changing pages without replacing the PDF document", async () => {
    const fixture = createPdfFixture();
    const secondPage = createDeferred<PdfPageFixture>();
    vi.mocked(fixture.document.getPage)
      .mockResolvedValueOnce(fixture.page)
      .mockReturnValueOnce(secondPage.promise);
    pdfRuntime.loadPdfJsRuntime.mockResolvedValue(fixture.runtime);
    pdfRuntime.openPdfDocument.mockReturnValue(fixture.loadingTask);

    render(<PdfCanvasPreview data={new Uint8Array([9, 8, 7])} />);
    await waitFor(() => expect(fixture.page.getViewport).toHaveBeenCalledOnce());
    const canvas = document.querySelector<HTMLCanvasElement>("[data-pdf-canvas]");
    expect(canvas?.width).toBe(150);
    expect(canvas?.height).toBe(100);

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(fixture.document.getPage).toHaveBeenCalledTimes(2));
    expect(screen.getByText("2 / 2")).toBeVisible();
    expect(canvas?.width).toBe(0);
    expect(canvas?.height).toBe(0);
    expect(canvas?.style.width).toBe("");
    expect(canvas?.style.height).toBe("");
    expect(pdfRuntime.openPdfDocument).toHaveBeenCalledOnce();

    await act(async () => {
      secondPage.resolve(fixture.page);
      await secondPage.promise;
    });
    await waitFor(() => expect(fixture.page.render).toHaveBeenCalledTimes(2));
  });

  it("clears a partially rendered canvas when rendering fails", async () => {
    const failedRender = createDeferred<void>();
    const fixture = createPdfFixture(2, failedRender.promise);
    pdfRuntime.loadPdfJsRuntime.mockResolvedValue(fixture.runtime);
    pdfRuntime.openPdfDocument.mockReturnValue(fixture.loadingTask);

    render(<PdfCanvasPreview data={new Uint8Array([7, 8, 9])} />);
    await waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    const canvas = document.querySelector<HTMLCanvasElement>("[data-pdf-canvas]");
    expect(canvas?.width).toBe(150);
    expect(canvas?.height).toBe(100);

    await act(async () => {
      failedRender.reject(new Error("paint failed"));
      await failedRender.promise.catch(() => undefined);
    });

    expect(await screen.findByText("无法预览 PDF")).toBeVisible();
    expect(canvas?.width).toBe(0);
    expect(canvas?.height).toBe(0);
    expect(canvas?.style.width).toBe("");
    expect(canvas?.style.height).toBe("");
  });

  it("cancels the active render before destroying the replaced loading task", async () => {
    const pendingRender = createDeferred<void>();
    const first = createPdfFixture(2, pendingRender.promise);
    const second = createPdfFixture();
    const lifecycle: string[] = [];
    vi.mocked(first.renderTask.cancel!).mockImplementation(() => {
      lifecycle.push("cancel");
    });
    vi.mocked(first.loadingTask.destroy).mockImplementation(async () => {
      lifecycle.push("destroy");
    });
    pdfRuntime.loadPdfJsRuntime
      .mockResolvedValueOnce(first.runtime)
      .mockResolvedValueOnce(second.runtime);
    pdfRuntime.openPdfDocument
      .mockReturnValueOnce(first.loadingTask)
      .mockReturnValueOnce(second.loadingTask);

    const { rerender } = render(
      <PdfCanvasPreview data={new Uint8Array([1])} />,
    );
    await waitFor(() => expect(first.page.render).toHaveBeenCalledOnce());

    rerender(<PdfCanvasPreview data={new Uint8Array([2])} />);

    await waitFor(() => expect(first.loadingTask.destroy).toHaveBeenCalledOnce());
    expect(first.renderTask.cancel).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(["cancel", "destroy"]);
  });

  it("ignores a page that resolves after its PDF bytes are replaced", async () => {
    const first = createPdfFixture();
    const second = createPdfFixture();
    const latePage = createDeferred<PdfPageFixture>();
    vi.mocked(first.document.getPage).mockReturnValue(latePage.promise);
    pdfRuntime.loadPdfJsRuntime
      .mockResolvedValueOnce(first.runtime)
      .mockResolvedValueOnce(second.runtime);
    pdfRuntime.openPdfDocument
      .mockReturnValueOnce(first.loadingTask)
      .mockReturnValueOnce(second.loadingTask);

    const { rerender } = render(
      <PdfCanvasPreview data={new Uint8Array([3])} />,
    );
    await waitFor(() => expect(first.document.getPage).toHaveBeenCalledOnce());

    rerender(<PdfCanvasPreview data={new Uint8Array([4])} />);
    await waitFor(() => expect(second.page.render).toHaveBeenCalledOnce());
    await act(async () => {
      latePage.resolve(first.page);
      await latePage.promise;
    });

    expect(first.page.render).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a replaced render that settles late by %s",
    async (completion) => {
      const lateRender = createDeferred<void>();
      const first = createPdfFixture(2, lateRender.promise);
      const second = createPdfFixture();
      second.page.getViewport.mockImplementation(({ scale }) => ({
        height: 100 * scale,
        width: 200 * scale,
      }));
      pdfRuntime.loadPdfJsRuntime
        .mockResolvedValueOnce(first.runtime)
        .mockResolvedValueOnce(second.runtime);
      pdfRuntime.openPdfDocument
        .mockReturnValueOnce(first.loadingTask)
        .mockReturnValueOnce(second.loadingTask);

      const { rerender } = render(
        <PdfCanvasPreview data={new Uint8Array([5])} />,
      );
      await waitFor(() => expect(first.page.render).toHaveBeenCalledOnce());

      rerender(<PdfCanvasPreview data={new Uint8Array([6])} />);
      await waitFor(() => expect(second.page.render).toHaveBeenCalledOnce());
      const canvas = document.querySelector<HTMLCanvasElement>("[data-pdf-canvas]");
      expect(first.renderTask.cancel).toHaveBeenCalledOnce();
      expect(canvas?.width).toBe(250);
      expect(canvas?.height).toBe(125);

      await act(async () => {
        if (completion === "resolve") {
          lateRender.resolve();
        } else {
          lateRender.reject(new Error("stale render failed"));
        }
        await lateRender.promise.catch(() => undefined);
      });

      expect(screen.queryByText("无法预览 PDF")).not.toBeInTheDocument();
      expect(canvas?.width).toBe(250);
      expect(canvas?.height).toBe(125);
      expect(canvas?.style.width).toBe("250px");
      expect(canvas?.style.height).toBe("125px");
    },
  );

  it("destroys a loading task immediately when PDF parsing fails", async () => {
    const fixture = createPdfFixture();
    const failedDocument = createDeferred<PdfDocument>();
    const loadingTask: PdfLoadingTask = {
      destroy: vi.fn(async () => undefined),
      promise: failedDocument.promise,
    };
    pdfRuntime.loadPdfJsRuntime.mockResolvedValue(fixture.runtime);
    pdfRuntime.openPdfDocument.mockReturnValue(loadingTask);

    const { unmount } = render(
      <PdfCanvasPreview data={new Uint8Array([5])} />,
    );
    await waitFor(() => expect(pdfRuntime.openPdfDocument).toHaveBeenCalledOnce());
    await act(async () => {
      failedDocument.reject(new Error("invalid PDF"));
      await Promise.resolve();
    });

    expect(await screen.findByText("无法预览 PDF")).toBeVisible();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    unmount();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });
});
