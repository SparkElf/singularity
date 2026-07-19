import { describe, expect, it, vi } from "vitest";

import {
  createProtylePluginPort,
  type ProtylePluginContribution,
  type ProtylePluginSlashContribution,
} from "./plugins.ts";

interface TestOptions {
  readonly order: readonly string[];
}

interface TestToolbarItem {
  readonly extra?: string;
  readonly name: string;
}

type TestToolbar = readonly TestToolbarItem[];

interface TestEditor {
  readonly id: string;
}

function contribution(
  value: ProtylePluginContribution<TestOptions, TestToolbar, TestEditor>,
) {
  return value;
}

describe("createProtylePluginPort", () => {
  it("applies option, toolbar, and synchronous event contributions in declaration order", () => {
    const eventOrder: string[] = [];
    const eventDetail = { marker: { preserved: true } };
    const firstToolbar = { extra: "preserved", name: "first" };
    const secondToolbar = { name: "second" };
    const first = contribution({
      name: "first",
      extendOptions: (options) => ({ order: [...options.order, "first"] }),
      extendToolbar: (toolbar) => [...toolbar, firstToolbar],
      onEvent: (event) => {
        expect(event.detail).toBe(eventDetail);
        eventOrder.push("first");
      },
    });
    const second = contribution({
      name: "second",
      extendOptions: (options) => ({ order: [...options.order, "second"] }),
      extendToolbar: (toolbar) => [...toolbar, secondToolbar],
      onEvent: (event) => {
        expect(event.detail).toBe(eventDetail);
        expect(eventOrder).toEqual(["first"]);
        eventOrder.push("second");
      },
    });
    const port = createProtylePluginPort<TestOptions, TestToolbar, TestEditor>([
      first,
      second,
    ]);
    const normalizeToolbar = vi.fn((toolbar: TestToolbar) => toolbar);

    expect(port.extendOptions({ order: [] })).toEqual({
      order: ["first", "second"],
    });
    expect(port.extendToolbar([], normalizeToolbar)).toEqual([
      firstToolbar,
      secondToolbar,
    ]);
    expect(normalizeToolbar).toHaveBeenCalledTimes(2);

    port.emit({ type: "loaded-protyle-static", detail: eventDetail });
    expect(eventOrder).toEqual(["first", "second"]);
    expect(eventDetail).toEqual({ marker: { preserved: true } });
  });

  it("runs the first matching command and resolves duplicate slash ids by plugin identity", () => {
    const firstCommand = vi.fn();
    const secondCommand = vi.fn();
    const firstSlashRun = vi.fn();
    const secondSlashRun = vi.fn();
    const firstSlash: ProtylePluginSlashContribution<TestEditor> = {
      extra: "preserved",
      filter: ["first"],
      html: "first",
      id: "shared",
      run: firstSlashRun,
    };
    const secondSlash: ProtylePluginSlashContribution<TestEditor> = {
      filter: ["second"],
      html: "second",
      id: "shared",
      run: secondSlashRun,
    };
    const port = createProtylePluginPort<TestOptions, TestToolbar, TestEditor>([
      contribution({
        commands: [{ hotkey: "same", run: firstCommand }],
        name: "first",
        slashItems: [firstSlash],
      }),
      contribution({
        commands: [{ hotkey: "same", run: secondCommand }],
        name: "second",
        slashItems: [secondSlash],
      }),
    ]);
    const editor = { id: "editor-a" };
    const event = new KeyboardEvent("keydown", { key: "K" });
    const nodeElement = document.createElement("div");
    const slashItems: Array<{ item: object; pluginName: string }> = [];

    expect(port.runEditorCommand(
      editor,
      event,
      (hotkey) => hotkey === "same",
    )).toBe(true);
    expect(firstCommand).toHaveBeenCalledWith(editor, event);
    expect(secondCommand).not.toHaveBeenCalled();

    port.forEachSlashItem((pluginName, item) => {
      slashItems.push({ item, pluginName });
    });
    expect(slashItems).toEqual([
      { item: firstSlash, pluginName: "first" },
      { item: secondSlash, pluginName: "second" },
    ]);
    expect(port.runSlashItem(
      "second",
      "shared",
      editor,
      nodeElement,
    )).toBe(true);
    expect(firstSlashRun).not.toHaveBeenCalled();
    expect(secondSlashRun).toHaveBeenCalledWith(editor, nodeElement);
    expect(port.runSlashItem(
      "missing",
      "shared",
      editor,
      nodeElement,
    )).toBe(false);
  });

  it("awaits paste transforms in order while retaining caller ownership and extra fields", async () => {
    const order: string[] = [];
    const firstPaste = async <TPayload extends object>(
      _editor: TestEditor,
      payload: TPayload,
    ): Promise<Partial<TPayload>> => {
      const current = payload as TPayload & {
        readonly pluginField?: string;
        readonly textPlain: string;
      };
      expect(current.textPlain).toBe("initial");
      order.push("first:start");
      await Promise.resolve();
      order.push("first:end");
      return {
        pluginField: "from-first",
        textPlain: "first",
      } as Partial<TPayload>;
    };
    const secondPaste = <TPayload extends object>(
      _editor: TestEditor,
      payload: TPayload,
    ): Partial<TPayload> => {
      const current = payload as TPayload & {
        readonly pluginField: string;
        readonly textPlain: string;
      };
      expect(current).toMatchObject({
        pluginField: "from-first",
        textPlain: "first",
      });
      order.push("second");
      return { textPlain: "second" } as Partial<TPayload>;
    };
    const port = createProtylePluginPort<TestOptions, TestToolbar, TestEditor>([
      contribution({ name: "first", transformPaste: firstPaste }),
      contribution({ name: "second", transformPaste: secondPaste }),
    ]);
    const source = {
      files: { length: 0 },
      pluginField: "source",
      textHTML: "<p>initial</p>",
      textPlain: "initial",
    };

    const transformed = await port.transformPaste({ id: "editor-a" }, source);

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(transformed).toEqual({
      files: source.files,
      pluginField: "from-first",
      textHTML: "<p>initial</p>",
      textPlain: "second",
    });
    expect(transformed).not.toBe(source);
    expect(source).toEqual({
      files: { length: 0 },
      pluginField: "source",
      textHTML: "<p>initial</p>",
      textPlain: "initial",
    });
  });

  it("rejects ambiguous identities and makes disposal idempotent and terminal", async () => {
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    const first = contribution({ name: "first", dispose: disposeFirst });

    expect(() => createProtylePluginPort<TestOptions, TestToolbar, TestEditor>([
      first,
      contribution({ name: "first" }),
    ])).toThrowError(/duplicate plugin name: first/);

    const port = createProtylePluginPort<TestOptions, TestToolbar, TestEditor>([
      first,
      contribution({ name: "second", dispose: disposeSecond }),
    ]);
    const firstDisposal = port.dispose();
    const secondDisposal = port.dispose();

    expect(firstDisposal).toBe(secondDisposal);
    await firstDisposal;
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeSecond).toHaveBeenCalledOnce();
    expect(() => port.extendOptions({ order: [] })).toThrowError(
      /cannot use the plugin port after disposal/,
    );
  });
});
