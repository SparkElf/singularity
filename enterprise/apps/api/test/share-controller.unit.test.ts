import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import type { HttpReplyBoundary } from "../src/http-boundary.js";
import { PublicShareController } from "../src/shares/share.controller.js";
import type { ShareService } from "../src/shares/share.service.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function requestBoundary(): {
  raw: IncomingMessage;
  request: Parameters<PublicShareController["readDocument"]>[1];
  socket: EventEmitter;
} {
  const socket = new EventEmitter() as EventEmitter & { destroyed: boolean };
  socket.destroyed = false;
  const raw = new EventEmitter() as EventEmitter & {
    aborted: boolean;
    socket: typeof socket;
  };
  raw.aborted = false;
  raw.socket = socket;
  return {
    raw: raw as unknown as IncomingMessage,
    request: {
      cookies: {},
      headers: {},
      id: "11111111-1111-4111-8111-111111111111",
      ip: "127.0.0.1",
      raw: raw as unknown as IncomingMessage,
      url: "/api/v1/shares/token",
    },
    socket,
  };
}

function replyBoundary(): {
  raw: EventEmitter & {
    destroy(): void;
    destroyed: boolean;
    writableFinished: boolean;
  };
  reply: Parameters<PublicShareController["readAsset"]>[2];
} {
  const raw = new EventEmitter() as EventEmitter & {
    destroy(): void;
    destroyed: boolean;
    writableFinished: boolean;
  };
  raw.destroyed = false;
  raw.writableFinished = false;
  raw.destroy = () => {
    raw.destroyed = true;
    raw.emit("close");
  };
  const reply = {
    header() {
      return reply;
    },
    raw: raw as unknown as ServerResponse,
  } as unknown as HttpReplyBoundary & { readonly raw: ServerResponse };
  return { raw, reply };
}

describe("public share request cancellation", () => {
  test("propagates request closure through a buffered document read and disposes listeners", async () => {
    const release = deferred();
    let signal: AbortSignal | undefined;
    const shares = {
      async readDocument(input: { signal: AbortSignal }) {
        signal = input.signal;
        await release.promise;
        return {
          payload: { assets: [], html: "<p>shared</p>", title: "Shared" },
          release: async () => {},
          terminateAtMilliseconds: Date.now() + 60_000,
        };
      },
    } as unknown as ShareService;
    const controller = new PublicShareController(shares);
    const boundary = requestBoundary();
    const reply = replyBoundary();

    const response = controller.readDocument(
      { shareToken: "a".repeat(43) },
      boundary.request,
      reply.reply,
    );
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);

    boundary.socket.emit("close");
    expect(signal?.aborted).toBe(true);
    release.resolve();
    await response;
    reply.raw.emit("close");

    expect(boundary.raw.listenerCount("aborted")).toBe(0);
    expect(boundary.socket.listenerCount("close")).toBe(0);
  });

  test("keeps the asset abort scope until the streamed response finishes", async () => {
    const body = new PassThrough();
    let releases = 0;
    let signal: AbortSignal | undefined;
    const shares = {
      async readAsset(input: { signal: AbortSignal }) {
        signal = input.signal;
        return {
          payload: {
            body,
            disposition: "inline" as const,
            fileName: "shared.png",
            mediaType: "image/png",
            sizeBytes: 4,
          },
          release: async () => {
            releases += 1;
          },
          terminateAtMilliseconds: Date.now() + 60_000,
        };
      },
    } as unknown as ShareService;
    const controller = new PublicShareController(shares);
    const request = requestBoundary();
    const response = replyBoundary();

    await controller.readAsset(
      { assetId: "a".repeat(64), shareToken: "b".repeat(43) },
      request.request,
      response.reply,
    );

    expect(signal?.aborted).toBe(false);
    expect(request.raw.listenerCount("aborted")).toBe(1);
    expect(request.socket.listenerCount("close")).toBe(1);
    body.resume();
    body.end("body");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releases).toBe(0);
    response.raw.writableFinished = true;
    response.raw.emit("finish");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releases).toBe(1);
    expect(request.raw.listenerCount("aborted")).toBe(0);
    expect(request.socket.listenerCount("close")).toBe(0);
  });
});
