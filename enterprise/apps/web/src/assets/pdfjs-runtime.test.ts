import { describe, expect, it, vi } from "vitest";

import {
  openPdfDocument,
  type PdfJsRuntime,
  type PdfLoadingTask,
} from "@/assets/pdfjs-runtime.ts";

describe("openPdfDocument", () => {
  it("uses checked-in PDF.js resources without scripting or PDF range fetches", () => {
    const loadingTask = {
      destroy: vi.fn(async () => undefined),
      promise: Promise.resolve({} as never),
    } satisfies PdfLoadingTask;
    const getDocument = vi.fn(() => loadingTask);
    const runtime = { getDocument } satisfies PdfJsRuntime;
    const bytes = new Uint8Array([37, 80, 68, 70]);

    expect(openPdfDocument(runtime, bytes)).toBe(loadingTask);
    expect(getDocument).toHaveBeenCalledWith({
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
  });
});
