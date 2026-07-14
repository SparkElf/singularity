import { describe, expect, it, vi } from "vitest";

import {
  createProtyleEditorRegistry,
  createProtyleFactory,
  createProtyleMenuPort,
  createProtyleOverlayPort,
  createProtyleSession,
} from "./index.ts";

describe("createProtyleFactory", () => {
  it("maps the public document identity once and fixes workspace participation", async () => {
    const controller = {
      destroy: vi.fn(),
      focus: vi.fn(),
      setHostReadOnly: vi.fn(),
    };
    const coreCreate = vi.fn().mockResolvedValue(controller);
    const factory = createProtyleFactory(
      { create: coreCreate },
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
      readOnly: true,
      session,
      signal,
    })).resolves.toBe(controller);
    expect(coreCreate).toHaveBeenCalledWith({
      host,
      options: { blockId: "document-a", render: { title: true } },
      participation: "live",
      readOnly: true,
      session,
      signal,
      surface: "workspace",
    });
  });
});

describe("createProtyleMenuPort", () => {
  it("keeps owner handles independent and reserves capability disposal for the session", () => {
    const closed: string[] = [];
    let nextMenu = 0;
    const menuPort = createProtyleMenuPort(
      () => ({ id: `menu-${++nextMenu}` }),
      (menu) => closed.push(menu.id),
    );
    const first = menuPort.open();
    const second = menuPort.open();

    first.close();
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
  it("closes and unregisters each owner handle exactly once", () => {
    const closed: string[] = [];
    const overlayPort = createProtyleOverlayPort<{ id: string }>((overlay) => {
      closed.push(overlay.id);
    });
    const first = { id: "overlay-1" };
    const second = { id: "overlay-2" };
    const firstHandle = overlayPort.add(first);
    overlayPort.add(second);

    firstHandle.close();
    firstHandle.close();
    const active: string[] = [];
    overlayPort.forEach((overlay) => active.push(overlay.id));

    expect(closed).toEqual([first.id]);
    expect(active).toEqual([second.id]);
    overlayPort.dispose();
    overlayPort.dispose();

    expect(closed).toEqual([first.id, second.id]);
    expect(() => overlayPort.add({ id: "late" })).toThrowError(/\[protyle\.overlays]/);
  });
});

describe("createProtyleSession", () => {
  it("owns one runtime and disposes its capabilities in the approved space-switch order", async () => {
    const order: string[] = [];
    const editors = createProtyleEditorRegistry<object>();
    editors.register({});
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
        dispose: () => order.push("transport"),
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
    expect(order).toEqual(["transport", "overlays", "menu", "plugins"]);
    expect(() => editors.register({})).toThrowError(/\[protyle\.registry]/);
    await expect(session.retrySubmission()).rejects.toThrowError(/\[protyle\.session]/);
  });
});
