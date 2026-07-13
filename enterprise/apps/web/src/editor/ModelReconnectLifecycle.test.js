import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../app/src/constants.ts", () => ({
  Constants: { SIYUAN_APPID: "test-app" },
}));
vi.mock("../../../../../app/src/util/kernelFault.ts", () => ({ kernelError: vi.fn() }));
vi.mock("../../../../../app/src/util/processMessage.ts", () => ({
  processMessage: vi.fn((message) => message),
}));
vi.mock("../../../../../app/src/util/reloadSync.ts", () => ({ reloadSync: vi.fn() }));

let Model;

class TestWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    this.send = vi.fn();
    TestWebSocket.instances.push(this);
  }
}

beforeAll(async () => {
  ({ Model } = await import("../../../../../app/src/layout/Model.ts"));
});

beforeEach(() => {
  vi.useFakeTimers();
  TestWebSocket.instances = [];
  vi.stubGlobal("WebSocket", TestWebSocket);
  globalThis.window.siyuan = { config: {}, dialogs: [] };
  vi.spyOn(globalThis.console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Model reconnect lifecycle", () => {
  it("disconnects once and cancels a queued reconnect", () => {
    const model = new Model({ app: {} });
    model.connect({ id: "editor", type: "protyle" });
    const socket = TestWebSocket.instances[0];
    socket.onclose({ reason: "network failure" });

    model.disconnect();
    model.disconnect();
    vi.advanceTimersByTime(3000);
    model.connect({ id: "late-editor", type: "protyle" });

    expect(socket.close).toHaveBeenCalledOnce();
    expect(TestWebSocket.instances).toHaveLength(1);
  });

  it("reconnects an active model once after the declared delay", () => {
    const model = new Model({ app: {} });
    model.connect({ id: "editor", type: "protyle" });
    const socket = TestWebSocket.instances[0];
    socket.onclose({ reason: "network failure" });

    vi.advanceTimersByTime(2999);
    expect(TestWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(TestWebSocket.instances).toHaveLength(2);
    expect(TestWebSocket.instances[1].url).toContain("id=editor&type=protyle");
  });
});
