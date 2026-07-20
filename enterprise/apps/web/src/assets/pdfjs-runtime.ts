interface PdfViewport {
  readonly height: number;
  readonly width: number;
}

export interface PdfRenderTask {
  cancel?(): void;
  readonly promise: Promise<void>;
}

interface PdfPage {
  getViewport(options: { readonly scale: number }): PdfViewport;
  render(options: {
    readonly canvasContext: CanvasRenderingContext2D;
    readonly transform?: readonly number[];
    readonly viewport: PdfViewport;
  }): PdfRenderTask;
}

export interface PdfDocument {
  readonly numPages: number;
  destroy(): Promise<void>;
  getPage(pageNumber: number): Promise<PdfPage>;
}

export interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

export interface PdfJsRuntime {
  getDocument(options: {
    readonly cMapPacked: true;
    readonly cMapUrl: string;
    readonly data: Uint8Array;
    readonly disableAutoFetch: true;
    readonly disableRange: true;
    readonly disableStream: true;
    readonly enableXfa: false;
    readonly isEvalSupported: false;
    readonly standardFontDataUrl: string;
    readonly useWasm: false;
  }): PdfLoadingTask;
}

interface PdfJsReadyEvent extends Event {
  readonly detail: PdfJsRuntime;
}

const PDF_RUNTIME_READY_EVENT = "singularity:pdfjs-ready";
const PDF_BRIDGE_URL = new URL("./pdf-runtime-bridge.mjs?no-inline", import.meta.url).href;
let runtimePromise: Promise<PdfJsRuntime> | null = null;

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  return reason instanceof Error
    ? reason
    : new Error(String(reason), { cause: reason });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (runtime) => {
        cleanup();
        resolve(runtime);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
      },
    );
  });
}

export function loadPdfJsRuntime(signal: AbortSignal): Promise<PdfJsRuntime> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  let currentRuntime = runtimePromise;
  if (!currentRuntime) {
    const pendingRuntime = new Promise<PdfJsRuntime>((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = PDF_BRIDGE_URL;

      const handleReady = (event: Event) => {
        cleanup();
        const runtime = (event as PdfJsReadyEvent).detail;
        resolve(runtime);
      };
      const handleError = () => {
        cleanup();
        runtimePromise = null;
        reject(new Error("[asset.preview] PDF.js runtime failed to load"));
      };
      const cleanup = () => {
        globalThis.removeEventListener(PDF_RUNTIME_READY_EVENT, handleReady);
        script.removeEventListener("error", handleError);
        script.remove();
      };

      globalThis.addEventListener(PDF_RUNTIME_READY_EVENT, handleReady, {
        once: true,
      });
      script.addEventListener("error", handleError, { once: true });
      document.head.append(script);
    });
    runtimePromise = pendingRuntime;
    currentRuntime = pendingRuntime;
    void pendingRuntime.catch(() => {
      if (runtimePromise === pendingRuntime) {
        runtimePromise = null;
      }
    });
  }

  return withAbort(currentRuntime, signal);
}

export function openPdfDocument(
  runtime: PdfJsRuntime,
  bytes: Uint8Array,
): PdfLoadingTask {
  return runtime.getDocument({
    cMapPacked: true,
    cMapUrl: "/stage/protyle/js/pdf/cmaps/",
    data: bytes,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    enableXfa: false,
    isEvalSupported: false,
    standardFontDataUrl: "/stage/protyle/js/pdf/standard_fonts/",
    useWasm: false,
  });
}
