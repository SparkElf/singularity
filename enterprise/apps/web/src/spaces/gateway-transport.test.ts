import {
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
} from "@singularity/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpaceGatewayTransport,
  GatewayResponseError,
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
  readonly status: number;
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
    this.responseText = result.body === undefined
      ? ""
      : JSON.stringify(result.body);
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
    headers: accessLost
      ? {
          [RUNTIME_ACCESS_LOST_HEADER_NAME]:
            RUNTIME_ACCESS_LOST_HEADER_VALUE,
        }
      : undefined,
    status: 404,
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

  it("does not invent a request ID for WebSocket message or close failures", () => {
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
    expect(first.onRuntimeError).toHaveBeenCalledWith({
      category: "kernel-unavailable",
      documentId: DOCUMENT_ID,
      type: "runtime-error",
    });

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
});
