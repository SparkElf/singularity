import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { describe, expect, test } from "vitest";

import { bindHttpRequestAbortSignal } from "../src/http-request-signal.js";

function createRequest(): { request: IncomingMessage; socket: Socket } {
  const socket = new Socket();
  return { request: new IncomingMessage(socket), socket };
}

describe("HTTP request abort scope", () => {
  test("aborts downstream work when the browser request is aborted", () => {
    const { request, socket } = createRequest();
    const scope = bindHttpRequestAbortSignal(request);
    try {
      request.emit("aborted");

      expect(scope.signal.aborted).toBe(true);
      expect(scope.signal.reason).toEqual(
        expect.objectContaining({ message: "HTTP request closed" }),
      );
    } finally {
      scope.dispose();
      request.destroy();
      socket.destroy();
    }
  });

  test("releases request and socket listeners after downstream I/O completes", () => {
    const { request, socket } = createRequest();
    const requestListenerCount = request.listenerCount("aborted");
    const socketListenerCount = socket.listenerCount("close");
    const scope = bindHttpRequestAbortSignal(request);
    try {
      expect(request.listenerCount("aborted")).toBe(requestListenerCount + 1);
      expect(socket.listenerCount("close")).toBe(socketListenerCount + 1);

      scope.dispose();
      expect(request.listenerCount("aborted")).toBe(requestListenerCount);
      expect(socket.listenerCount("close")).toBe(socketListenerCount);

      socket.emit("close");
      expect(scope.signal.aborted).toBe(false);
    } finally {
      scope.dispose();
      request.destroy();
      socket.destroy();
    }
  });
});
