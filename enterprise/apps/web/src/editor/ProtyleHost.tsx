import type {
  ProtyleController,
  ProtyleFactory,
  ProtyleSession,
} from "@singularity/protyle-browser";
import { useEffect, useEffectEvent, useRef, useState } from "react";

interface ProtyleHostProps<TRuntime> {
  documentId: string;
  factory: ProtyleFactory<TRuntime>;
  notebookId: string;
  onError?: (error: unknown) => void;
  readOnly: boolean;
  session: ProtyleSession<TRuntime>;
}

type ProtyleHostStatus = "error" | "loading" | "ready";

export function ProtyleHost<TRuntime>({
  documentId,
  factory,
  notebookId,
  onError,
  readOnly,
  session,
}: ProtyleHostProps<TRuntime>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ProtyleController>(null);
  const [status, setStatus] = useState<ProtyleHostStatus>("loading");
  const getCurrentReadOnly = useEffectEvent(() => readOnly);
  const applyLatestReadOnly = useEffectEvent((controller: ProtyleController, initialReadOnly: boolean) => {
    if (readOnly !== initialReadOnly) {
      controller.setHostReadOnly(readOnly);
    }
  });
  const reportError = useEffectEvent((error: unknown) => {
    onError?.(error);
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const abortController = new AbortController();
    const initialReadOnly = getCurrentReadOnly();
    let controller: ProtyleController | null = null;
    setStatus("loading");

    void factory.create({
      documentId,
      host,
      notebookId,
      readOnly: initialReadOnly,
      session,
      signal: abortController.signal,
    }).then((createdController) => {
      if (abortController.signal.aborted) {
        createdController.destroy();
        return;
      }

      controller = createdController;
      controllerRef.current = createdController;
      applyLatestReadOnly(createdController, initialReadOnly);
      setStatus("ready");
    }).catch((error: unknown) => {
      if (abortController.signal.aborted) {
        return;
      }
      setStatus("error");
      reportError(error);
    });

    return () => {
      abortController.abort();
      if (controller) {
        controller.destroy();
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }
    };
  }, [documentId, factory, notebookId, session]);

  useEffect(() => {
    controllerRef.current?.setHostReadOnly(readOnly);
  }, [readOnly]);

  return (
    <div className="relative h-full min-h-0" data-protyle-state={status}>
      <div
        key={`${session.spaceId}:${notebookId}:${documentId}`}
        ref={hostRef}
        aria-busy={status === "loading"}
        className="h-full min-h-0"
        data-testid="protyle-host"
      />
      {status === "error" ? (
        <div className="absolute inset-0 grid place-items-center bg-background text-sm text-destructive" role="alert">
          编辑器加载失败
        </div>
      ) : null}
    </div>
  );
}
