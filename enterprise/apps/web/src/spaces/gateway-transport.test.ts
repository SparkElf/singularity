import {
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
} from "@singularity/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpaceGatewayTransport,
  GatewayResponseError,
  type SpaceGatewayCollaborationBinding,
} from "@/spaces/gateway-transport.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTEBOOK_ID = "20260718000000-noteb01";
const DOCUMENT_ID = "20260718000100-docum01";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

const requestOptions = {
  identity: {
    documentId: DOCUMENT_ID,
    notebookId: NOTEBOOK_ID,
  },
  intent: "read" as const,
};

function notFoundResponse(accessLost: boolean): Response {
  return new Response(
    JSON.stringify({ code: "not-found", requestId: REQUEST_ID, status: 404 }),
    {
      headers: {
        "Content-Type": "application/problem+json",
        ...(accessLost
          ? {
              [RUNTIME_ACCESS_LOST_HEADER_NAME]:
                RUNTIME_ACCESS_LOST_HEADER_VALUE,
            }
          : {}),
      },
      status: 404,
    },
  );
}

function createTransport(onRuntimeError = vi.fn()) {
  return {
    onRuntimeError,
    transport: createSpaceGatewayTransport<unknown>({
      getCsrfToken: async () => "csrf-token",
      onRuntimeError,
      space: { organizationId: ORGANIZATION_ID, spaceId: SPACE_ID },
    }),
  };
}

interface UploadResult {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawBody?: string;
  readonly status: number;
}

interface GatewayErrorLogEntry {
  readonly context: Record<string, unknown>;
  readonly error: unknown;
}

function captureGatewayErrors(): GatewayErrorLogEntry[] {
  const entries: GatewayErrorLogEntry[] = [];
  vi.spyOn(console, "error").mockImplementation((label, context, error) => {
    if (
      label === "[protyle.gateway]" &&
      typeof context === "object" &&
      context !== null
    ) {
      entries.push({
        context: context as Record<string, unknown>,
        error,
      });
    }
  });
  return entries;
}

class TestXMLHttpRequest {
  static results: UploadResult[] = [];

  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  responseText = "";
  status = 0;
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };

  #responseHeaders = new Map<string, string>();

  abort(): void {
    this.onabort?.();
  }

  getResponseHeader(name: string): string | null {
    return this.#responseHeaders.get(name.toLowerCase()) ?? null;
  }

  open(): void {}

  send(): void {
    const result = TestXMLHttpRequest.results.shift();
    if (!result) {
      throw new Error("No test upload response was configured");
    }
    this.status = result.status;
    this.responseText = result.rawBody ?? (result.body === undefined
      ? ""
      : JSON.stringify(result.body));
    this.#responseHeaders = new Map(
      Object.entries(result.headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    queueMicrotask(() => this.onload?.());
  }

  setRequestHeader(): void {}
}

function uploadResult(accessLost: boolean): UploadResult {
  return {
    body: { code: "not-found", requestId: REQUEST_ID, status: 404 },
    status: 404,
    ...(accessLost
      ? {
          headers: {
            [RUNTIME_ACCESS_LOST_HEADER_NAME]:
              RUNTIME_ACCESS_LOST_HEADER_VALUE,
          },
        }
      : {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestXMLHttpRequest.results = [];
});

describe("SpaceGatewayTransport runtime access loss", () => {
  it("freezes the active session after a Gateway-hidden request 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notFoundResponse(true)));
    const { onRuntimeError, transport } = createTransport();

    await expect(
      transport.request("/api/filetree/getDoc", {}, requestOptions),
    ).rejects.toBeInstanceOf(GatewayResponseError);
    expect(onRuntimeError).toHaveBeenCalledWith({
      category: "forbidden",
      documentId: DOCUMENT_ID,
      triggeringRequestId: REQUEST_ID,
      type: "runtime-error",
    });
    await expect(
      transport.request("/api/filetree/getDoc", {}, requestOptions),
    ).rejects.toThrowError(/commands are frozen/);
  });

  it("keeps the session available after a Kernel business request 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(notFoundResponse(false))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    const { onRuntimeError, transport } = createTransport();

    await expect(
      transport.request("/api/block/getBlockInfo", {}, requestOptions),
    ).rejects.toBeInstanceOf(GatewayResponseError);
    expect(onRuntimeError).not.toHaveBeenCalled();
    await expect(
      transport.request("/api/block/getBlockInfo", {}, requestOptions),
    ).resolves.toBeUndefined();
  });

  it("freezes the active session after a Gateway-hidden upload 404", async () => {
    TestXMLHttpRequest.results = [uploadResult(true)];
    vi.stubGlobal("XMLHttpRequest", TestXMLHttpRequest);
    const { onRuntimeError, transport } = createTransport();

    await expect(
      transport.upload(new FormData(), { identity: requestOptions.identity }),
    ).rejects.toBeInstanceOf(GatewayResponseError);
    expect(onRuntimeError).toHaveBeenCalledWith({
      category: "forbidden",
      documentId: DOCUMENT_ID,
      triggeringRequestId: REQUEST_ID,
      type: "runtime-error",
    });
    await expect(
      transport.upload(new FormData(), { identity: requestOptions.identity }),
    ).rejects.toThrowError(/commands are frozen/);
  });

  it("keeps the session available after a Kernel business upload 404", async () => {
    TestXMLHttpRequest.results = [uploadResult(false), { status: 204 }];
    vi.stubGlobal("XMLHttpRequest", TestXMLHttpRequest);
    const { onRuntimeError, transport } = createTransport();

    await expect(
      transport.upload(new FormData(), { identity: requestOptions.identity }),
    ).rejects.toBeInstanceOf(GatewayResponseError);
    expect(onRuntimeError).not.toHaveBeenCalled();
    await expect(
      transport.upload(new FormData(), { identity: requestOptions.identity }),
    ).resolves.toBeUndefined();
  });

  it("does not invent a request ID for a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
    const { onRuntimeError, transport } = createTransport();

    await expect(
      transport.request("/api/filetree/getDoc", {}, requestOptions),
    ).rejects.toThrowError("offline");
    expect(onRuntimeError).toHaveBeenCalledWith({
      category: "network-failure",
      documentId: DOCUMENT_ID,
      type: "runtime-error",
    });
  });

  it("freezes on a malformed unauthenticated response and retains its parsing stack", async () => {
    const loggedErrors = captureGatewayErrors();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", {
      headers: { "X-Request-Id": REQUEST_ID },
      status: 401,
    })));
    const { onRuntimeError, transport } = createTransport();

    const [result] = await Promise.allSettled([
      transport.request("/api/filetree/getDoc", {}, requestOptions),
    ]);

    expect(result?.status).toBe("rejected");
    if (result?.status !== "rejected") {
      throw new Error("Expected the malformed response to be rejected");
    }
    expect(result.reason).toBeInstanceOf(GatewayResponseError);
    expect(result.reason).toMatchObject({
      status: 401,
      triggeringRequestId: REQUEST_ID,
    });
    expect(onRuntimeError).toHaveBeenCalledWith({
      category: "unauthenticated",
      documentId: DOCUMENT_ID,
      triggeringRequestId: REQUEST_ID,
      type: "runtime-error",
    });
    const parseEntry = loggedErrors.find(
      ({ context }) => context.phase === "problem-response-json",
    );
    const gatewayError = result.reason as unknown as { readonly cause?: unknown };
    expect(parseEntry?.error).toBe(gatewayError.cause);
    expect(parseEntry?.error).toBeInstanceOf(SyntaxError);
    expect((parseEntry?.error as Error).stack).toContain(
      (parseEntry?.error as Error).message,
    );
  });

  it("freezes on a malformed forbidden upload and retains its parsing stack", async () => {
    const loggedErrors = captureGatewayErrors();
    TestXMLHttpRequest.results = [{
      headers: { "X-Request-Id": REQUEST_ID },
      rawBody: "{",
      status: 403,
    }];
    vi.stubGlobal("XMLHttpRequest", TestXMLHttpRequest);
    const { onRuntimeError, transport } = createTransport();

    const [result] = await Promise.allSettled([
      transport.upload(new FormData(), { identity: requestOptions.identity }),
    ]);

    expect(result?.status).toBe("rejected");
    if (result?.status !== "rejected") {
      throw new Error("Expected the malformed upload response to be rejected");
    }
    expect(result.reason).toBeInstanceOf(GatewayResponseError);
    expect(result.reason).toMatchObject({
      status: 403,
      triggeringRequestId: REQUEST_ID,
    });
    expect(onRuntimeError).toHaveBeenCalledWith({
      category: "forbidden",
      documentId: DOCUMENT_ID,
      triggeringRequestId: REQUEST_ID,
      type: "runtime-error",
    });
    const parseEntry = loggedErrors.find(
      ({ context }) => context.phase === "upload-response-json",
    );
    const uploadError = result.reason as unknown as { readonly cause?: unknown };
    expect(parseEntry?.error).toBe(uploadError.cause);
    expect(parseEntry?.error).toBeInstanceOf(SyntaxError);
    expect((parseEntry?.error as Error).stack).toContain(
      (parseEntry?.error as Error).message,
    );
  });

  it("does not invent a request ID for WebSocket message or close failures", () => {
    const loggedErrors = captureGatewayErrors();
    class TestWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static instances: TestWebSocket[] = [];

      onclose: ((event: { readonly code: number }) => void) | null = null;
      onmessage: ((event: { readonly data: unknown }) => void) | null = null;
      readyState = TestWebSocket.OPEN;

      constructor() {
        TestWebSocket.instances.push(this);
      }

      close(): void {
        this.readyState = TestWebSocket.CLOSED;
      }

      emitMessage(data: unknown): void {
        this.onmessage?.({ data });
      }

      emitClose(code: number): void {
        this.readyState = TestWebSocket.CLOSED;
        this.onclose?.({ code });
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);

    const first = createTransport();
    first.transport.subscribe({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
      onMessage: vi.fn(),
      type: "protyle",
    });
    TestWebSocket.instances[0]!.emitMessage("{");
    expect(TestWebSocket.instances[0]!.readyState).toBe(TestWebSocket.CLOSED);
    expect(first.onRuntimeError).toHaveBeenCalledWith({
      category: "kernel-unavailable",
      documentId: DOCUMENT_ID,
      type: "runtime-error",
    });
    const parseEntry = loggedErrors.find(
      ({ context }) => context.phase === "websocket-message-json",
    );
    expect(parseEntry?.error).toBeInstanceOf(SyntaxError);
    expect((parseEntry?.error as Error).stack).toContain(
      (parseEntry?.error as Error).message,
    );

    const second = createTransport();
    second.transport.subscribe({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
      onMessage: vi.fn(),
      type: "protyle",
    });
    TestWebSocket.instances[1]!.emitClose(1006);
    expect(second.onRuntimeError).toHaveBeenCalledWith({
      category: "network-failure",
      documentId: DOCUMENT_ID,
      type: "runtime-error",
    });
  });

  it("filters ordinary transaction pushes but keeps the explicit undo replay push", () => {
    class TestWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static instance: TestWebSocket | undefined;

      onclose: ((event: { readonly code: number }) => void) | null = null;
      onmessage: ((event: { readonly data: string }) => void) | null = null;
      readyState = TestWebSocket.OPEN;

      constructor() {
        TestWebSocket.instance = this;
      }

      close(): void {
        this.readyState = TestWebSocket.CLOSED;
      }

      emitMessage(value: unknown): void {
        this.onmessage?.({ data: JSON.stringify(value) });
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);

    const received: unknown[] = [];
    const { transport } = createTransport();
    const binding: SpaceGatewayCollaborationBinding<unknown> = {
      client: {
        submitOperation: async () => {
          throw new Error("not used in transaction push contract");
        },
        subscribe: () => () => undefined,
      },
      clientId: "33333333-3333-4333-8333-333333333333",
      identity: {
        documentId: DOCUMENT_ID,
        notebookId: NOTEBOOK_ID,
        organizationId: ORGANIZATION_ID,
        spaceId: SPACE_ID,
      },
      mapBroadcast: () => "mapped",
      mapOperation: () => [],
    };
    transport.attachCollaboration(binding);
    transport.subscribe({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
      onMessage: (message) => received.push(message),
      type: "protyle",
    });

    TestWebSocket.instance?.emitMessage({ cmd: "transactions", data: [] });
    expect(received).toHaveLength(0);
    TestWebSocket.instance?.emitMessage({
      cmd: "transactions",
      context: { isUndoReplay: true },
      data: [],
    });
    expect(received).toHaveLength(1);
  });

  it("detaches collaboration broadcasts when the transport freezes", () => {
    const unsubscribe = vi.fn();
    const { transport } = createTransport();
    transport.attachCollaboration({
      client: {
        submitOperation: async () => {
          throw new Error("not used in freeze contract");
        },
        subscribe: () => unsubscribe,
      },
      clientId: "33333333-3333-4333-8333-333333333333",
      identity: {
        documentId: DOCUMENT_ID,
        notebookId: NOTEBOOK_ID,
        organizationId: ORGANIZATION_ID,
        spaceId: SPACE_ID,
      },
      mapBroadcast: () => "mapped",
      mapOperation: () => [],
    });

    transport.freeze();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
