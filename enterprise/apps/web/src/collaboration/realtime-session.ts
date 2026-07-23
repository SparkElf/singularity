import {
  collaborationClientMessageSchema,
  collaborationOperationEnvelopeSchema,
  collaborationServerMessageSchema,
  type CollaborationBroadcast,
  type CollaborationCapability,
  type CollaborationFeatureMode,
  type CollaborationOperationEnvelope,
  type CollaborationOperationResult,
  type CollaborationPresence,
  type CollaborationServerMessage,
  type CollaborationWebSocketErrorCode,
  type DocumentIdentity,
} from "@singularity/contracts";
import { create } from "zustand";

import type { CollaborationOperation } from "@singularity/contracts";

export type RealtimeSessionState = "connecting" | "ready" | "reconnecting" | "conflict" | "revoked" | "closed";

interface RealtimeSessionStore {
  readonly identity: DocumentIdentity | null;
  readonly clientId: string | null;
  readonly featureMode: CollaborationFeatureMode | null;
  readonly sessionGeneration: number | null;
  readonly state: RealtimeSessionState;
  readonly pendingOperationIds: readonly string[];
  readonly lastResult: CollaborationOperationResult | null;
  readonly lastBroadcastSequence: number | null;
  readonly resumedBroadcastCount: number;
  readonly lastErrorCode: CollaborationWebSocketErrorCode | null;
  readonly presence: readonly CollaborationPresence[];
  readonly causalContext: Readonly<Record<string, number>>;
  setState: (next: Partial<Pick<RealtimeSessionStore, "identity" | "clientId" | "featureMode" | "sessionGeneration" | "state">>) => void;
  trackOperation: (operationId: string) => void;
  clearPendingOperations: () => void;
  consumeResult: (result: CollaborationOperationResult) => void;
  acceptOperation: (operationId: string, clientId: string, clientSequence: number) => void;
  recordBroadcast: (broadcast: CollaborationBroadcast) => void;
  recordResumed: (broadcasts: readonly CollaborationBroadcast[]) => void;
  setPresence: (presence: readonly CollaborationPresence[]) => void;
  setErrorCode: (code: CollaborationWebSocketErrorCode | null) => void;
  resetIfIdentity: (identity: DocumentIdentity) => void;
  reset: () => void;
}

const initialState = {
  causalContext: {},
  clientId: null,
  featureMode: null,
  identity: null,
  lastBroadcastSequence: null,
  lastErrorCode: null,
  lastResult: null,
  pendingOperationIds: [],
  presence: [],
  resumedBroadcastCount: 0,
  sessionGeneration: null,
  state: "closed" as RealtimeSessionState,
};

function sameIdentity(left: DocumentIdentity | null, right: DocumentIdentity): boolean {
  return left !== null && left.organizationId === right.organizationId &&
    left.spaceId === right.spaceId && left.notebookId === right.notebookId &&
    left.documentId === right.documentId;
}

function advanceCausalContext(
  current: Readonly<Record<string, number>>,
  clientId: string,
  clientSequence: number,
): Readonly<Record<string, number>> {
  if ((current[clientId] ?? 0) >= clientSequence) {
    return current;
  }
  return { ...current, [clientId]: clientSequence };
}

export const useRealtimeSessionStore = create<RealtimeSessionStore>((set) => ({
  ...initialState,
  clearPendingOperations: () => set({ pendingOperationIds: [] }),
  consumeResult: (result) => set((current) => ({
    lastResult: result,
    pendingOperationIds: current.pendingOperationIds.filter((id) => id !== result.operationId),
    state: result.outcome === "conflict" ? "conflict" : current.state,
  })),
  acceptOperation: (operationId, clientId, clientSequence) => set((current) => ({
    causalContext: advanceCausalContext(current.causalContext, clientId, clientSequence),
    pendingOperationIds: current.pendingOperationIds.filter((id) => id !== operationId),
  })),
  recordBroadcast: (broadcast) => set((current) => ({
    causalContext: advanceCausalContext(
      current.causalContext,
      broadcast.operation.clientId,
      broadcast.operation.clientSequence,
    ),
    lastBroadcastSequence: broadcast.serverSequence,
  })),
  recordResumed: (broadcasts) => set((current) => ({
    causalContext: broadcasts.reduce(
      (context, broadcast) => advanceCausalContext(
        context,
        broadcast.operation.clientId,
        broadcast.operation.clientSequence,
      ),
      current.causalContext,
    ),
    resumedBroadcastCount: broadcasts.length,
    lastBroadcastSequence: broadcasts.at(-1)?.serverSequence ?? current.lastBroadcastSequence,
  })),
  reset: () => set(initialState),
  setPresence: (presence) => set({ presence: [...presence] }),
  setErrorCode: (lastErrorCode) => set({ lastErrorCode }),
  resetIfIdentity: (identity) => set((current) => sameIdentity(current.identity, identity) ? initialState : current),
  setState: (next) => set(next),
  trackOperation: (operationId) => set((current) => ({
    pendingOperationIds: current.pendingOperationIds.includes(operationId)
      ? current.pendingOperationIds
      : [...current.pendingOperationIds, operationId],
  })),
}));

function websocketPath(): string {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/v1/collaboration/ws`;
}

function assertMessageBinding(
  message: CollaborationServerMessage,
  identity: DocumentIdentity,
  sessionGeneration: number | null,
): void {
  const assertIdentity = (candidate: DocumentIdentity): void => {
    if (!sameIdentity(candidate, identity)) {
      throw new Error("Realtime collaboration message identity does not match the bound document");
    }
  };
  const assertGeneration = (candidate: number): void => {
    if (sessionGeneration !== null && candidate !== sessionGeneration) {
      throw new Error("Realtime collaboration message session generation is stale");
    }
  };
  switch (message.type) {
    case "joined":
      assertIdentity(message.response.identity);
      return;
    case "operation-result":
      assertIdentity(message.result.identity);
      assertGeneration(message.result.sessionGeneration);
      return;
    case "operation-broadcast":
      assertIdentity(message.broadcast.identity);
      assertIdentity(message.broadcast.operation.identity);
      assertGeneration(message.broadcast.operation.sessionGeneration);
      return;
    case "resumed":
      message.broadcasts.forEach((broadcast) => {
        assertIdentity(broadcast.identity);
        assertIdentity(broadcast.operation.identity);
        assertGeneration(broadcast.operation.sessionGeneration);
      });
      return;
    case "presence":
      message.presence.forEach((entry) => {
        assertIdentity(entry.identity);
        assertGeneration(entry.sessionGeneration);
      });
      return;
    case "revoked":
      assertIdentity(message.revocation.identity);
      assertGeneration(message.revocation.sessionGeneration);
      return;
    case "error":
      return;
  }
}

/** 专用协作 WSS 客户端只传显式四段身份和语义操作，不读取 DOM 或首个响应推断文档。 */
export function createRealtimeCollaborationClient(input: {
  readonly capability: CollaborationCapability;
  readonly clientId: string;
  readonly featureMode: CollaborationFeatureMode;
  readonly identity: DocumentIdentity;
  readonly onMessage?: (message: CollaborationServerMessage) => void;
  readonly onState?: (state: RealtimeSessionState) => void;
  readonly protocolVersion?: number;
}) {
  let socket: WebSocket | null = null;
  let sessionGeneration: number | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let manualClose = false;
  let hasJoined = false;
  let nextClientSequence = 0;
  const pendingSequences = new Map<string, { readonly clientId: string; readonly clientSequence: number }>();
  const pendingResults = new Map<string, {
    readonly resolve: (result: CollaborationOperationResult) => void;
    readonly reject: (error: Error) => void;
  }>();
  const listeners = new Set<(message: CollaborationServerMessage) => void>();
  const clearPendingOperations = (): void => {
    pendingSequences.clear();
    const current = useRealtimeSessionStore.getState();
    if (current.identity === null || sameIdentity(current.identity, input.identity)) {
      current.clearPendingOperations();
    }
  };
  const rejectPendingOperations = (error: Error): void => {
    pendingResults.forEach(({reject}) => reject(error));
    pendingResults.clear();
    clearPendingOperations();
  };
  const onState = (state: RealtimeSessionState): void => {
    input.onState?.(state);
    const current = useRealtimeSessionStore.getState();
    if (current.identity === null || sameIdentity(current.identity, input.identity)) {
      current.setState({ state, identity: input.identity, clientId: input.clientId });
    }
  };
  const send = (message: unknown, targetSocket: WebSocket | null = socket): void => {
    if (targetSocket?.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime collaboration socket is not ready");
    }
    targetSocket.send(JSON.stringify(collaborationClientMessageSchema.parse(message)));
  };
  // 连接事件只允许改变其创建时对应的 socket，避免旧连接的迟到事件污染新会话。
  const connect = (): void => {
    if (socket !== null || manualClose) {
      return;
    }
    onState("connecting");
    const currentSocket = new WebSocket(websocketPath());
    socket = currentSocket;
    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket || manualClose) {
        return;
      }
      reconnectAttempt = 0;
      send({
        request: {
          capability: input.capability,
          clientId: input.clientId,
          featureMode: input.featureMode,
          identity: input.identity,
          protocolVersion: input.protocolVersion ?? 1,
        },
        type: "join",
      }, currentSocket);
    });
    currentSocket.addEventListener("message", (event) => {
      if (socket !== currentSocket || manualClose) {
        return;
      }
      let message: CollaborationServerMessage;
      try {
        message = collaborationServerMessageSchema.parse(JSON.parse(String(event.data)));
        assertMessageBinding(message, input.identity, sessionGeneration);
      } catch (error) {
        console.error("[collaboration.websocket]", {
          error: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { name: "UnknownError", message: String(error), stack: undefined },
          event: "message",
          outcome: "invalid-server-message",
          identity: input.identity,
        });
        currentSocket.close(1000, "invalid server message");
        onState("reconnecting");
        return;
      }
      try {
        const boundStore = useRealtimeSessionStore.getState();
        if (boundStore.identity !== null && !sameIdentity(boundStore.identity, input.identity)) {
          return;
        }
        if (message.type === "joined") {
          sessionGeneration = message.response.sessionGeneration;
          nextClientSequence = Math.max(
            nextClientSequence,
            useRealtimeSessionStore.getState().causalContext[input.clientId] ?? 0,
          );
          const wasConnected = hasJoined;
          hasJoined = true;
          useRealtimeSessionStore.getState().setState({
            clientId: input.clientId,
            featureMode: message.response.featureMode,
            identity: message.response.identity,
            sessionGeneration,
            state: "ready",
          });
          useRealtimeSessionStore.getState().setErrorCode(null);
          if (wasConnected) {
            send({
              request: {
                causalContext: useRealtimeSessionStore.getState().causalContext,
                clientId: input.clientId,
                identity: input.identity,
                sessionGeneration,
              },
              type: "resume",
            });
          }
        } else if (message.type === "operation-result") {
          useRealtimeSessionStore.getState().consumeResult(message.result);
          const pending = pendingSequences.get(message.result.operationId);
          if (pending !== undefined && (message.result.outcome === "accepted" || message.result.outcome === "duplicate")) {
            useRealtimeSessionStore.getState().acceptOperation(
              message.result.operationId,
              pending.clientId,
              pending.clientSequence,
            );
            pendingSequences.delete(message.result.operationId);
          }
          const pendingResult = pendingResults.get(message.result.operationId);
          if (pendingResult !== undefined) {
            pendingResults.delete(message.result.operationId);
            pendingResult.resolve(message.result);
          }
          if (message.result.outcome !== "accepted" && message.result.outcome !== "duplicate") {
            pendingSequences.delete(message.result.operationId);
          }
        } else if (message.type === "operation-broadcast") {
          useRealtimeSessionStore.getState().recordBroadcast(message.broadcast);
        } else if (message.type === "resumed") {
          useRealtimeSessionStore.getState().recordResumed(message.broadcasts);
        } else if (message.type === "presence") {
          useRealtimeSessionStore.getState().setPresence(message.presence);
        } else if (message.type === "revoked") {
          sessionGeneration = message.revocation.sessionGeneration;
          onState("revoked");
        } else if (message.type === "error") {
          useRealtimeSessionStore.getState().setErrorCode(message.code);
          const terminal = message.code !== "service-unavailable";
          if (!hasJoined || terminal) {
            manualClose = true;
            onState("closed");
            currentSocket.close(1000, message.code);
          } else {
            onState("reconnecting");
            currentSocket.close(1000, message.code);
          }
        }
        input.onMessage?.(message);
        listeners.forEach((listener) => {
          try {
            listener(message);
          } catch (error) {
            console.error("[collaboration.websocket] listener failed", {
              error: error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : { name: "UnknownError", message: String(error), stack: undefined },
              event: "listener",
              identity: input.identity,
            });
          }
        });
      } catch (error) {
        const errorDetails = error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "UnknownError", message: String(error), stack: undefined };
        console.error("[collaboration.websocket]", {
          error: errorDetails,
          event: "message",
          identity: input.identity,
          messageType: message.type,
          outcome: "message-handler-failed",
        });
        currentSocket.close(1000, "message handler failed");
        onState("reconnecting");
      }
    });
    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket) {
        return;
      }
      socket = null;
      const error = new Error(
        manualClose
          ? "Realtime collaboration session was closed"
          : "Realtime collaboration operation was interrupted by disconnect",
      );
      rejectPendingOperations(error);
      if (!manualClose && useRealtimeSessionStore.getState().state !== "revoked") {
        const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        onState("reconnecting");
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      } else if (useRealtimeSessionStore.getState().state !== "revoked") {
        onState("closed");
      }
    });
    currentSocket.addEventListener("error", (event) => {
      if (socket !== currentSocket) {
        return;
      }
      const transportError = event instanceof ErrorEvent && event.error instanceof Error
        ? event.error
        : new Error("WebSocket transport failed");
      console.error("[collaboration.websocket]", {
        error: {
          name: transportError.name,
          message: transportError.message,
          stack: transportError.stack,
        },
        event: "error",
        identity: input.identity,
      });
      onState("reconnecting");
    });
  };
  const submit = (
    operation: CollaborationOperation,
    operationId: string,
    clientSequence: number,
    causalContext: Readonly<Record<string, number>>,
  ): Promise<CollaborationOperationResult> => {
    if (sessionGeneration === null) {
      return Promise.reject(new Error("Realtime collaboration session is not ready"));
    }
    const envelope: CollaborationOperationEnvelope = collaborationOperationEnvelopeSchema.parse({
      causalContext,
      clientId: input.clientId,
      clientSequence,
      identity: input.identity,
      operation,
      operationId,
      sessionGeneration,
    });
    useRealtimeSessionStore.getState().trackOperation(operationId);
    pendingSequences.set(operationId, { clientId: input.clientId, clientSequence });
    const result = new Promise<CollaborationOperationResult>((resolve, reject) => {
      pendingResults.set(operationId, { reject, resolve });
    });
    try {
      send({ envelope, type: "submit" });
    } catch (error) {
      pendingResults.delete(operationId);
      pendingSequences.delete(operationId);
      const failure = error instanceof Error ? error : new Error(String(error));
      return Promise.reject(failure);
    }
    return result;
  };
  // 提交只使用当前会话代次和本地因果位置；断线期间不创建隐式备用写入路径。
  const submitOperation = (operation: CollaborationOperation): Promise<CollaborationOperationResult> => {
    const clientSequence = Math.max(
      nextClientSequence + 1,
      (useRealtimeSessionStore.getState().causalContext[input.clientId] ?? 0) + 1,
    );
    nextClientSequence = clientSequence;
    const operationId = globalThis.crypto.randomUUID();
    const causalContext = useRealtimeSessionStore.getState().causalContext;
    return submit(operation, operationId, clientSequence, causalContext);
  };
  /** 发送当前编辑器的临时光标状态；未加入或断线时不创建悬挂 presence 请求。 */
  const updatePresence = (
    cursor: CollaborationPresence["cursor"],
    ttlMs = 10_000,
  ): boolean => {
    if (sessionGeneration === null || socket === null || !hasJoined || manualClose) {
      return false;
    }
    try {
      send({
        presence: {
          clientId: input.clientId,
          cursor,
          identity: input.identity,
          sessionGeneration,
          ttlMs,
        },
        type: "presence",
      });
      return true;
    } catch (error) {
      console.error("[collaboration.websocket] presence send failed", {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "UnknownError", message: String(error), stack: undefined },
        event: "presence",
        identity: input.identity,
      });
      return false;
    }
  };
  return {
    connect,
    close: () => {
      manualClose = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close(1000, "closed");
      socket = null;
      rejectPendingOperations(new Error("Realtime collaboration session was closed"));
      onState("closed");
    },
    subscribe: (listener: (message: CollaborationServerMessage) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit,
    submitOperation,
    updatePresence,
  };
}
