import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DownloadIcon,
  FileWarningIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

import { PdfCanvasPreview } from "@/assets/PdfCanvasPreview.tsx";

const INLINE_MEDIA_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/ogg",
  "video/webm",
]);

type AssetState =
  | {
      readonly kind: "error";
      readonly message: string;
      readonly source: string;
    }
  | { readonly kind: "loading" }
  | {
      readonly downloadName: string;
      readonly downloadSrc: string;
      readonly kind: "download";
      readonly mediaType: string;
      readonly source: string;
    }
  | {
      readonly bytes?: Uint8Array;
      readonly downloadName: string;
      readonly downloadSrc: string;
      readonly kind: "ready";
      readonly mediaType: string;
      readonly source: string;
      readonly url: string | null;
    };

export interface AssetPreviewProps {
  readonly downloadSrc: string;
  readonly initialPage?: number | string;
  readonly src: string;
}

function normalizedMediaType(value: string | null): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType;
}

function safeDownloadName(value: string | null, source: string): string {
  const encodedName = value?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  const plainName = value?.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  const candidate = encodedName?.[1] ?? plainName?.[1] ?? plainName?.[2];
  let decoded = candidate ?? "download";
  try {
    decoded = decodeURIComponent(decoded.trim());
  } catch (error) {
    console.error(
      "[asset.preview]",
      { operation: "decode-download-name", result: "failed" },
      error,
    );
    decoded = "download";
  }
  if (decoded === "download" && URL.canParse(source, window.location.href)) {
    const pathName = new URL(source, window.location.href).pathname;
    decoded = pathName.split("/").at(-1) ?? decoded;
  }
  const sanitized = decoded.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized.length > 0 && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : "download";
}

function mediaKind(mediaType: string): "audio" | "image" | "video" | null {
  if (!INLINE_MEDIA_TYPES.has(mediaType)) {
    return null;
  }
  if (mediaType.startsWith("image/")) {
    return "image";
  }
  if (mediaType.startsWith("audio/")) {
    return "audio";
  }
  return "video";
}

function DownloadPanel({
  name,
  src,
  title,
}: {
  readonly name: string;
  readonly src: string;
  readonly title: string;
}) {
  return (
    <div className="grid min-h-40 place-items-center gap-3 rounded-md border bg-muted/20 p-6 text-center">
      <FileWarningIcon aria-hidden="true" className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">请下载后使用此附件。</p>
      </div>
      <Button asChild variant="outline">
        <a download={name} href={src} rel="noopener">
          <DownloadIcon aria-hidden="true" />
          下载文件
        </a>
      </Button>
    </div>
  );
}

export function AssetPreview({ downloadSrc, initialPage, src }: AssetPreviewProps) {
  const [state, setState] = useState<AssetState>({ kind: "loading" });
  const autoDownloadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let objectUrl: string | null = null;
    // 源地址变化时先清除旧媒体状态，随后只接受当前请求的结果。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ kind: "loading" });

    void fetch(src, {
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      mode: "same-origin",
      redirect: "error",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (disposed) {
          return;
        }
        if (!response.ok) {
          throw new Error("asset request failed");
        }
        const mediaType = normalizedMediaType(response.headers.get("content-type"));
        const downloadName = safeDownloadName(
          response.headers.get("content-disposition"),
          src,
        );
        if (mediaType === "application/pdf") {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (disposed) {
            return;
          }
          setState({
            bytes,
            downloadName,
            downloadSrc,
            kind: "ready",
            mediaType,
            source: src,
            url: null,
          });
          return;
        }

        const kind = mediaKind(mediaType);
        if (!kind) {
          if (response.body) {
            void response.body.cancel().catch((error: unknown) => {
              console.error(
                "[asset.preview]",
                { operation: "discard-active-content", result: "failed" },
                error,
              );
            });
          }
          setState({
            downloadName,
            downloadSrc,
            kind: "download",
            mediaType,
            source: src,
          });
          return;
        }

        const blob = await response.blob();
        if (disposed) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({
          downloadName,
          downloadSrc,
          kind: "ready",
          mediaType,
          source: src,
          url: objectUrl,
        });
      })
      .catch((error: unknown) => {
        if (!disposed && !controller.signal.aborted) {
          console.error(
            "[asset.preview]",
            { operation: "fetch", result: "failed" },
            error,
          );
          setState({
            kind: "error",
            message: "服务未返回可用附件。",
            source: src,
          });
        }
      });

    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [downloadSrc, src]);

  useEffect(() => {
    if (state.kind !== "download" || state.source !== src) {
      return;
    }
    const downloadKey = `${state.source}\n${state.downloadSrc}`;
    if (autoDownloadKeyRef.current === downloadKey) {
      return;
    }
    autoDownloadKeyRef.current = downloadKey;
    const anchor = document.createElement("a");
    anchor.download = state.downloadName;
    anchor.href = state.downloadSrc;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }, [src, state]);

  const kind = state.kind === "ready" ? mediaKind(state.mediaType) : null;

  if (state.kind === "loading" || state.source !== src) {
    return (
      <div className="grid min-h-40 place-items-center" data-asset-loading>
        <Spinner aria-label="正在加载附件" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <Alert data-asset-error variant="destructive">
        <AlertTitle>附件无法加载</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  if (state.kind === "ready" && state.mediaType === "application/pdf" && state.bytes) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-asset-kind="pdf">
        <PdfCanvasPreview
          data={state.bytes}
          {...(initialPage === undefined ? {} : { initialPage })}
        />
        <Button asChild className="self-end" variant="outline">
          <a download={state.downloadName} href={state.downloadSrc} rel="noopener">
            <DownloadIcon aria-hidden="true" />
            下载 PDF
          </a>
        </Button>
      </div>
    );
  }
  if (state.kind === "download") {
    return (
      <DownloadPanel
        name={state.downloadName}
        src={state.downloadSrc}
        title="该附件需要下载后使用"
      />
    );
  }
  if (state.kind !== "ready" || !kind || !state.url) {
    return (
      <DownloadPanel
        name={state.downloadName}
        src={state.downloadSrc}
        title="该附件需要下载后使用"
      />
    );
  }
  if (kind === "image") {
    return (
      <div className="grid min-h-40 place-items-center overflow-auto rounded-md border bg-muted/20 p-3" data-asset-kind="image">
        <img alt={state.downloadName} className="max-h-[70vh] max-w-full object-contain" src={state.url} />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="grid min-h-40 place-items-center rounded-md border bg-muted/20 p-6" data-asset-kind="audio">
        <audio controls src={state.url} />
      </div>
    );
  }
  return (
    <div className="grid min-h-40 place-items-center rounded-md border bg-muted/20 p-6" data-asset-kind="video">
      <video className="max-h-[70vh] max-w-full" controls src={state.url} />
    </div>
  );
}
