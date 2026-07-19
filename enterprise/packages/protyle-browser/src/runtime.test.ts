import { describe, expect, it, vi } from "vitest";

import {
  createProtyleEditorRegistry,
  createEmptyProtylePluginPort,
  createProtyleFactory,
  createProtyleMenuPort,
  createProtyleOverlayPort,
  createProtyleSession,
} from "./index.ts";
import type { ProtyleController, ProtyleCoreFactory } from "./contracts.ts";

interface TestProtyleOptions {
  readonly blockId?: string;
  readonly notebookId?: string;
  readonly render: { readonly title: boolean };
}

describe("createProtyleFactory", () => {
  it("maps the public notebook and document identity once and fixes the workspace contract", async () => {
    const controller = {
      destroy: vi.fn(),
      focus: vi.fn(),
      navigateDocument: vi.fn(() => Promise.resolve()),
      setHostReadOnly: vi.fn(),
    };
    const coreCreate = vi.fn().mockResolvedValue(controller);
    const coreFactory: ProtyleCoreFactory<TestProtyleOptions, unknown> = {
      create: coreCreate,
    };
    const factory = createProtyleFactory(
      coreFactory,
      { render: { title: true } },
    );
    const host = new EventTarget() as HTMLElement;
    const signal = new AbortController().signal;
    const session = {
      dispose: () => undefined,
      retrySubmission: () => Promise.resolve(),
      runtime: {},
      spaceId: "space-a",
    };

    await expect(factory.create({
      documentId: "document-a",
      host,
      notebookId: "notebook-a",
      readOnly: true,
      session,
      signal,
    })).resolves.toBe(controller);
    expect(coreCreate).toHaveBeenCalledWith({
      content: { mode: "bound", notebookId: "notebook-a" },
      host,
      initialLoad: "automatic",
      options: { blockId: "document-a", render: { title: true } },
      participation: "live",
      readOnly: true,
      session,
      signal,
      surface: "workspace",
    });
  });
});

describe("createEmptyProtylePluginPort", () => {
  it("preserves zero-plugin inputs and enters a terminal state on disposal", async () => {
    const port = createEmptyProtylePluginPort<object, object[], object>();
    const options = { render: true };
    const toolbar = [{ name: "strong" }];
    const paste = { extra: "preserved", textPlain: "content" };

    expect(port.extendOptions(options)).toBe(options);
    expect(port.extendToolbar(toolbar, vi.fn())).toBe(toolbar);
    const transformedPaste = await port.transformPaste({}, paste);
    expect(transformedPaste).toEqual(paste);
    expect(transformedPaste).toBe(paste);

    await port.dispose();
    await port.dispose();

    expect(() => port.extendOptions(options)).toThrowError(/\[protyle\.plugins]/);
  });
});

describe("createProtyleMenuPort", () => {
  it("keeps owner handles independent and reserves capability disposal for the session", () => {
    const closed: string[] = [];
    let nextMenu = 0;
    const menuPort = createProtyleMenuPort(
      (close) => ({ close, id: `menu-${++nextMenu}` }),
      (menu) => closed.push(menu.id),
    );
    const first = menuPort.open();
    const second = menuPort.open();

    first.menu.close();
    first.close();
    const third = menuPort.open();

    expect(closed).toEqual([first.menu.id]);
    menuPort.dispose();
    menuPort.dispose();

    expect(closed).toEqual([first.menu.id, second.menu.id, third.menu.id]);
    expect(() => menuPort.open()).toThrowError(/\[protyle\.menu]/);
  });
});

describe("createProtyleOverlayPort", () => {
  it("notifies each owner before closing and unregisters its handle exactly once", () => {
    const lifecycle: string[] = [];
    const overlayPort = createProtyleOverlayPort<{ id: string }>((overlay) => {
      lifecycle.push(`closed:${overlay.id}`);
    });
    const first = { id: "overlay-1" };
    const second = { id: "overlay-2" };
    const firstHandle = overlayPort.add(first, () => {
      lifecycle.push(`owner:${first.id}`);
    });
    overlayPort.add(second, () => {
      lifecycle.push(`owner:${second.id}`);
    });

    firstHandle.close();
    firstHandle.close();
    const active: string[] = [];
    overlayPort.forEach((overlay) => active.push(overlay.id));

    expect(lifecycle).toEqual([`owner:${first.id}`, `closed:${first.id}`]);
    expect(active).toEqual([second.id]);
    overlayPort.dispose();
    overlayPort.dispose();

    expect(lifecycle).toEqual([
      `owner:${first.id}`,
      `closed:${first.id}`,
      `owner:${second.id}`,
      `closed:${second.id}`,
    ]);
    expect(() => overlayPort.add({ id: "late" })).toThrowError(/\[protyle\.overlays]/);
  });

  it("attempts every owner and overlay close before reporting a disposal failure", () => {
    const lifecycle: string[] = [];
    const ownerFailure = new Error("owner close failed");
    const overlayPort = createProtyleOverlayPort<{ id: string }>((overlay) => {
      lifecycle.push(`closed:${overlay.id}`);
    });
    overlayPort.add({ id: "overlay-1" }, () => {
      lifecycle.push("owner:overlay-1");
      throw ownerFailure;
    });
    overlayPort.add({ id: "overlay-2" }, () => {
      lifecycle.push("owner:overlay-2");
    });

    expect(() => overlayPort.dispose()).toThrowError(AggregateError);
    expect(lifecycle).toEqual([
      "owner:overlay-1",
      "closed:overlay-1",
      "owner:overlay-2",
      "closed:overlay-2",
    ]);
  });
});

describe("createProtyleSession", () => {
  it("seals editor registration before disposing capabilities in the approved space-switch order", async () => {
    const order: string[] = [];
    const editors = createProtyleEditorRegistry<ProtyleController>();
    const firstEditor = {
      destroy: vi.fn(() => {
        order.push("editor-1");
        unregisterFirst();
      }),
      focus: vi.fn(),
      navigateDocument: vi.fn(() => Promise.resolve()),
      setHostReadOnly: vi.fn(),
    } satisfies ProtyleController;
    const secondEditor = {
      destroy: vi.fn(() => order.push("editor-2")),
      focus: vi.fn(),
      navigateDocument: vi.fn(() => Promise.resolve()),
      setHostReadOnly: vi.fn(),
    } satisfies ProtyleController;
    const reentrantEditor = {
      destroy: vi.fn(),
      focus: vi.fn(),
      navigateDocument: vi.fn(() => Promise.resolve()),
      setHostReadOnly: vi.fn(),
    } satisfies ProtyleController;
    let unregisterFirst: () => void = () => undefined;
    unregisterFirst = editors.register(firstEditor);
    editors.register(secondEditor);
    const overlays = createProtyleOverlayPort<{ id: string }>(() => {
      order.push("overlays");
    });
    overlays.add({ id: "overlay" });
    const menu = createProtyleMenuPort(
      () => ({ id: "menu" }),
      () => {
        const activeOverlays: object[] = [];
        overlays.forEach((overlay) => activeOverlays.push(overlay));
        expect(activeOverlays).toEqual([]);
        order.push("menu");
      },
    );
    menu.open();
    const runtime = {
      transport: {
        dispose: () => {
          expect(() => editors.register(reentrantEditor)).toThrowError(/after sealing/);
          order.push("transport");
        },
      },
      overlays,
      menu,
      editors,
      plugins: {
        dispose: () => {
          expect(editors.find(() => true)).toBeUndefined();
          order.push("plugins");
        },
      },
    };
    const retrySubmission = vi.fn(() => Promise.resolve());
    const session = createProtyleSession({
      spaceId: "space-a",
      runtime,
      retrySubmission,
    });

    expect(session.runtime).toBe(runtime);
    expect(Object.hasOwn(session, "host")).toBe(false);
    await session.retrySubmission();
    await Promise.all([session.dispose(), session.dispose()]);

    expect(retrySubmission).toHaveBeenCalledOnce();
    expect(order).toEqual(["transport", "overlays", "menu", "editor-1", "editor-2", "plugins"]);
    expect(firstEditor.destroy).toHaveBeenCalledOnce();
    expect(secondEditor.destroy).toHaveBeenCalledOnce();
    expect(reentrantEditor.destroy).not.toHaveBeenCalled();
    expect(() => editors.register(firstEditor)).toThrowError(/\[protyle\.registry]/);
    await expect(session.retrySubmission()).rejects.toThrowError(/\[protyle\.session]/);
  });

  it("attempts every editor and capability cleanup before reporting disposal failures", async () => {
    const order: string[] = [];
    const editorFailure = new Error("editor disposal failed");
    const pluginFailure = new Error("plugin disposal failed");
    const editors = createProtyleEditorRegistry<ProtyleController>();
    const firstEditor = {
      destroy: vi.fn(() => {
        order.push("editor-1");
        throw editorFailure;
      }),
      focus: vi.fn(),
      navigateDocument: vi.fn(() => Promise.resolve()),
      setHostReadOnly: vi.fn(),
    } satisfies ProtyleController;
    const secondEditor = {
      destroy: vi.fn(() => order.push("editor-2")),
      focus: vi.fn(),
      navigateDocument: vi.fn(() => Promise.resolve()),
      setHostReadOnly: vi.fn(),
    } satisfies ProtyleController;
    editors.register(firstEditor);
    editors.register(secondEditor);
    const session = createProtyleSession({
      spaceId: "space-a",
      runtime: {
        transport: { dispose: () => order.push("transport") },
        overlays: {
          bringToFront: () => undefined,
          dispose: () => order.push("overlays"),
        },
        menu: {
          dispose: () => order.push("menu"),
        },
        editors,
        plugins: {
          dispose: () => {
            expect(editors.find(() => true)).toBeUndefined();
            order.push("plugins");
            throw pluginFailure;
          },
        },
      },
      retrySubmission: () => Promise.resolve(),
    });

    const disposal = session.dispose();

    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    await expect(disposal).rejects.toMatchObject({ errors: [editorFailure, pluginFailure] });
    await expect(session.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(["transport", "overlays", "menu", "editor-1", "editor-2", "plugins"]);
    expect(firstEditor.destroy).toHaveBeenCalledOnce();
    expect(secondEditor.destroy).toHaveBeenCalledOnce();
    expect(() => editors.register(firstEditor)).toThrowError(/\[protyle\.registry]/);
  });
});
