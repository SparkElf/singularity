import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collaborationClientMessageSchema } from "@singularity/contracts";

import {
  createRealtimeCollaborationClient,
  useRealtimeSessionStore,
} from "@/collaboration/realtime-session.ts";

const identity = {
  documentId: "20260722090000-docabcd",
  notebookId: "20260722090001-bookabc",
  organizationId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
} as const;
const clientId = "33333333-3333-4333-8333-333333333333";

type EventListener = (event: unknown) => void;

class TestWebSocket {
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static instances: TestWebSocket[] = [];

  readonly sent: string[] = [];
  readonly url: string;
  readonly closeCalls: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
  readyState = TestWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    TestWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    if (this.readyState !== TestWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = TestWebSocket.CLOSED;
  }

  emit(type: string, event: unknown = { type }): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  emitOpen(): void {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open");
  }

  emitMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  emitClose(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close");
  }
}

function joinedMessage(sessionGeneration = 1) {
  return {
    response: {
      capability: "editor",
      featureMode: "standard",
      identity,
      protocolVersion: 1,
      sessionGeneration,
      sessionState: "ready",
      version: {},
    },
    type: "joined",
  };
}

function createClient() {
  return createRealtimeCollaborationClient({
    capability: "editor",
    clientId,
    featureMode: "standard",
    identity,
  });
}

function connectReady() {
  const client = createClient();
  client.connect();
  const socket = TestWebSocket.instances.at(-1)!;
  socket.emitOpen();
  socket.emitMessage(joinedMessage());
  return { client, socket };
}

describe("realtime collaboration session lifecycle", () => {
  beforeEach(() => {
    TestWebSocket.instances = [];
    useRealtimeSessionStore.getState().reset();
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    useRealtimeSessionStore.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves submit only when the matching operation result arrives", async () => {
    const { client, socket } = connectReady();
    const resultPromise = client.submitOperation({
      blockId: "20260722090002-block01",
      kind: "text.insert",
      position: 0,
      text: "hello",
    });
    const submitMessage = collaborationClientMessageSchema.parse(JSON.parse(socket.sent[1]!));
    if (submitMessage.type !== "submit") {
      throw new Error("Expected a collaboration submit message");
    }
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.emitMessage({
      result: {
        identity,
        operationId: submitMessage.envelope.operationId,
        outcome: "accepted",
        serverSequence: 1,
        sessionGeneration: 1,
      },
      type: "operation-result",
    });

    await expect(resultPromise).resolves.toMatchObject({
      operationId: submitMessage.envelope.operationId,
      outcome: "accepted",
    });
    expect(useRealtimeSessionStore.getState().pendingOperationIds).toEqual([]);
    client.close();
  });

  it("rejects and clears pending operations on manual close", async () => {
    const { client } = connectReady();
    const resultPromise = client.submitOperation({
      blockId: "20260722090002-block01",
      kind: "text.insert",
      position: 0,
      text: "pending",
    });

    expect(useRealtimeSessionStore.getState().pendingOperationIds).toHaveLength(1);
    client.close();

    await expect(resultPromise).rejects.toThrow("session was closed");
    expect(useRealtimeSessionStore.getState().pendingOperationIds).toEqual([]);
  });

  it("ignores a stale socket close after a replacement connection exists", () => {
    const client = createClient();
    client.connect();
    const firstSocket = TestWebSocket.instances[0]!;
    firstSocket.emitOpen();
    firstSocket.emitMessage(joinedMessage());
    firstSocket.emitClose();
    vi.advanceTimersByTime(500);

    const secondSocket = TestWebSocket.instances[1]!;
    firstSocket.emitClose();
    vi.advanceTimersByTime(1_000);

    expect(TestWebSocket.instances).toHaveLength(2);
    secondSocket.emitOpen();
    secondSocket.emitMessage(joinedMessage(2));
    expect(useRealtimeSessionStore.getState().state).toBe("ready");
    client.close();
  });

  it("rejects unconfirmed operations when a transport disconnects", async () => {
    const {client, socket} = connectReady();
    const resultPromise = client.submitOperation({
      blockId: "20260722090002-block01",
      kind: "text.insert",
      position: 0,
      text: "interrupted",
    });

    socket.emitClose();

    await expect(resultPromise).rejects.toThrow("interrupted by disconnect");
    expect(useRealtimeSessionStore.getState().pendingOperationIds).toEqual([]);
    client.close();
  });

  it("settles a terminal server error without reporting a protocol error", () => {
    const { client, socket } = connectReady();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      socket.emitMessage({ code: "collaboration-disabled", type: "error" });

      expect(useRealtimeSessionStore.getState().state).toBe("closed");
      expect(useRealtimeSessionStore.getState().lastErrorCode).toBe("collaboration-disabled");
      expect(socket.closeCalls.at(-1)?.code).toBe(1000);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      client.close();
    }
  });
});
