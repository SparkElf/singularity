import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

import {
  loadPdfJsRuntime,
  openPdfDocument,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfRenderTask,
} from "@/assets/pdfjs-runtime.ts";

export interface PdfCanvasPreviewProps {
  readonly data: Uint8Array;
  readonly initialPage?: number | string;
}

type PreviewStatus = "error" | "loading" | "ready";

interface LoadedDocument {
  readonly document: PdfDocument;
  readonly pageCount: number;
}

function normalizePage(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function isCancelledRenderError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "RenderingCancelledException" ||
    error.message.toLowerCase().includes("cancel")
  );
}

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) {
    return;
  }
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.removeProperty("height");
  canvas.style.removeProperty("width");
}

export function PdfCanvasPreview({
  data,
  initialPage,
}: PdfCanvasPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRenderCleanupRef = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [pageNumber, setPageNumber] = useState(() => normalizePage(initialPage));
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    // 初始页码属于输入变化后的同步状态，必须先于 PDF 请求重置。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPageNumber(normalizePage(initialPage));
  }, [data, initialPage]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let loadingTask: PdfLoadingTask | null = null;
    let loadingTaskDestroyed = false;
    const loadingCanvas = canvasRef.current;
    const destroyLoadingTask = () => {
      if (!loadingTask || loadingTaskDestroyed) {
        return;
      }
      loadingTaskDestroyed = true;
      void loadingTask.destroy().catch((error: unknown) => {
        console.error(
          "[asset.preview]",
          { operation: "pdf-destroy", result: "failed" },
          error,
        );
      });
    };
    activeRenderCleanupRef.current?.();
    // 替换 PDF 前清空旧文档、错误和画布，避免旧页短暂可见。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(null);
    setRenderError(false);
    setStatus("loading");
    clearCanvas(loadingCanvas);

    void loadPdfJsRuntime(controller.signal)
      .then((runtime) => {
        if (disposed) {
          return null;
        }
        // PDF.js 可能把输入缓冲区转移给 Worker；跨越 Worker 所有权边界时只复制这份字节。
        const task = openPdfDocument(runtime, new Uint8Array(data));
        loadingTask = task;
        return task.promise;
      })
      .then((document) => {
        if (!document) {
          return;
        }
        if (disposed) {
          destroyLoadingTask();
          return;
        }
        const pageCount = Math.max(1, document.numPages);
        setLoaded({ document, pageCount });
        setPageNumber((current) => Math.min(current, pageCount));
        setStatus("ready");
      })
      .catch((error: unknown) => {
        destroyLoadingTask();
        if (!disposed && !controller.signal.aborted) {
          console.error(
            "[asset.preview]",
            { operation: "pdf-load", result: "failed" },
            error,
          );
          setStatus("error");
        }
      });

    return () => {
      disposed = true;
      activeRenderCleanupRef.current?.();
      controller.abort();
      destroyLoadingTask();
      clearCanvas(loadingCanvas);
    };
  }, [data]);

  useEffect(() => {
    activeRenderCleanupRef.current?.();
    const canvas = canvasRef.current;
    const current = loaded;
    if (!canvas || !current || status !== "ready") {
      return;
    }
    clearCanvas(canvas);

    const context = canvas.getContext("2d");
    if (!context) {
      console.error(
        "[asset.preview]",
        { operation: "pdf-canvas-context", result: "failed" },
        new Error("PDF canvas 2D context is unavailable"),
      );
      setRenderError(true);
      return;
    }

    let cancelled = false;
    let renderTask: PdfRenderTask | null = null;
    let cleanedUp = false;
    const cleanupRender = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      cancelled = true;
      renderTask?.cancel?.();
      if (activeRenderCleanupRef.current === cleanupRender) {
        activeRenderCleanupRef.current = null;
      }
    };
    activeRenderCleanupRef.current = cleanupRender;
    setRenderError(false);

    const targetPage = Math.min(pageNumber, current.pageCount);
    if (targetPage !== pageNumber) {
      // PDF 文档页数变化时收敛到合法页码，避免再次请求不存在的页面。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPageNumber(targetPage);
      return cleanupRender;
    }

    void current.document.getPage(targetPage)
      .then((page) => {
        if (cancelled) {
          return;
        }

        const viewport = page.getViewport({ scale: 1.25 });
        const deviceScale = Math.min(
          2,
          Math.max(1, window.devicePixelRatio || 1),
        );
        canvas.width = Math.ceil(viewport.width * deviceScale);
        canvas.height = Math.ceil(viewport.height * deviceScale);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        context.clearRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({
          canvasContext: context,
          ...(deviceScale === 1
            ? {}
            : { transform: [deviceScale, 0, 0, deviceScale, 0, 0] }),
          viewport,
        });
        return renderTask.promise;
      })
      .then(() => {
        if (!cancelled) {
          setRenderError(false);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && !isCancelledRenderError(error)) {
          console.error(
            "[asset.preview]",
            { operation: "pdf-render", result: "failed" },
            error,
          );
          clearCanvas(canvas);
          setRenderError(true);
        }
      });

    return cleanupRender;
  }, [loaded, pageNumber, status]);

  const pageCount = loaded?.pageCount ?? 0;
  const canNavigate = status === "ready" && pageCount > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-pdf-preview>
      <div className="flex shrink-0 items-center justify-between gap-2" data-pdf-controls>
        <Button
          aria-label="上一页"
          disabled={!canNavigate || pageNumber <= 1}
          onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          size="icon-sm"
          variant="outline"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {pageCount > 0 ? `${pageNumber} / ${pageCount}` : "加载中"}
        </span>
        <Button
          aria-label="下一页"
          disabled={!canNavigate || pageNumber >= pageCount}
          onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
          size="icon-sm"
          variant="outline"
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto rounded-md bg-muted/40 p-3">
        <div className="grid min-h-full min-w-full place-items-start justify-center">
          <canvas
            aria-label={`PDF 第 ${pageNumber} 页`}
            className="max-w-full bg-white shadow-sm"
            data-pdf-canvas
            ref={canvasRef}
            role="img"
          />
        </div>
        {status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center" data-pdf-loading>
            <Spinner aria-label="正在加载 PDF" />
          </div>
        ) : null}
      </div>

      {status === "error" || renderError ? (
        <Alert variant="destructive" data-pdf-error>
          <AlertTitle>无法预览 PDF</AlertTitle>
          <AlertDescription>文件内容无法在当前窗口中渲染。</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
