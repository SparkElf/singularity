import type {
  ProtyleController,
  ProtyleDocumentNavigation,
  ProtyleFactory,
  ProtyleSession,
} from "@singularity/protyle-browser";
import { useEffect, useEffectEvent, useRef, useState } from "react";

export interface ProtyleHostNavigationCommand {
  readonly navigation: ProtyleDocumentNavigation;
  readonly sequence: number;
}

interface ProtyleHostProps<TRuntime> {
  documentId: string;
  factory: ProtyleFactory<TRuntime>;
  navigationCommand?: ProtyleHostNavigationCommand | null;
  notebookId: string;
  onError?: (error: unknown) => void;
  onNavigationCommandComplete?: (sequence: number) => void;
  readOnly: boolean;
  session: ProtyleSession<TRuntime>;
}

type ProtyleHostStatus = "error" | "loading" | "ready";

export function ProtyleHost<TRuntime>({
  documentId,
  factory,
  navigationCommand,
  notebookId,
  onError,
  onNavigationCommandComplete,
  readOnly,
  session,
}: ProtyleHostProps<TRuntime>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ProtyleController>(null);
  const consumedNavigationSequenceRef = useRef<number | null>(null);
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
  const consumeNavigationCommand = useEffectEvent((controller: ProtyleController) => {
    const command = navigationCommand;
    if (
      !command ||
      consumedNavigationSequenceRef.current === command.sequence ||
      command.navigation.notebookId !== notebookId ||
      command.navigation.documentId !== documentId
    ) {
      return;
    }

    consumedNavigationSequenceRef.current = command.sequence;
    void controller.navigateDocument(command.navigation).then(() => {
      if (
        controllerRef.current === controller &&
        consumedNavigationSequenceRef.current === command.sequence
      ) {
        onNavigationCommandComplete?.(command.sequence);
      }
    }).catch(reportError);
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
      consumeNavigationCommand(createdController);
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

  useEffect(() => {
    const controller = controllerRef.current;
    if (controller) {
      consumeNavigationCommand(controller);
    }
  }, [navigationCommand]);

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
