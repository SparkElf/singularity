import { describe, expect, it, vi } from "vitest";

import { createProtyleEditorRegistry } from "./index.ts";

describe("createProtyleEditorRegistry", () => {
  it("keeps insertion order and returns one idempotent unregister action per editor", () => {
    const registry = createProtyleEditorRegistry<object>();
    const first = {};
    const second = {};
    const unregisterFirst = registry.register(first);

    expect(registry.register(first)).toBe(unregisterFirst);
    registry.register(second);
    const visited: object[] = [];
    registry.forEach((editor) => visited.push(editor));
    expect(visited).toEqual([first, second]);
    expect(registry.find((editor) => editor === second)).toBe(second);

    unregisterFirst();
    unregisterFirst();
    expect(registry.find((editor) => editor === first)).toBeUndefined();
  });

  it("tracks only registered active editors without guessing a replacement", () => {
    const registry = createProtyleEditorRegistry<object>();
    const first = {};
    const second = {};
    const unknown = {};
    registry.register(first);
    registry.register(second);

    expect(registry.getActive()).toBe(first);
    expect(registry.activate(unknown)).toBe(false);
    expect(registry.getActive()).toBe(first);
    expect(registry.activate(second)).toBe(true);
    expect(registry.getActive()).toBe(second);

    registry.unregister(second);
    expect(registry.getActive()).toBeUndefined();

    const third = {};
    registry.register(third);
    expect(registry.getActive()).toBeUndefined();
  });

  it("does not let a stale unregister action remove a later registration", () => {
    const registry = createProtyleEditorRegistry<object>();
    const editor = {};
    const staleUnregister = registry.register(editor);
    registry.unregister(editor);
    registry.register(editor);

    staleUnregister();

    expect(registry.find((candidate) => candidate === editor)).toBe(editor);
  });

  it("visits the live collection without exposing an array snapshot", () => {
    const registry = createProtyleEditorRegistry<object>();
    const first = {};
    const second = {};
    registry.register(first);
    registry.register(second);
    const visitor = vi.fn((editor: object) => {
      if (editor === first) {
        registry.unregister(second);
      }
    });

    registry.forEach(visitor);

    expect(visitor).toHaveBeenCalledOnce();
    expect(registry.find((editor) => editor === second)).toBeUndefined();
  });

  it("disposes once, clears active state, and rejects late registration", () => {
    const registry = createProtyleEditorRegistry<object>();
    registry.register({});

    registry.dispose();
    registry.dispose();

    expect(registry.getActive()).toBeUndefined();
    expect(registry.find(() => true)).toBeUndefined();
    expect(() => registry.register({})).toThrowError(/\[protyle\.registry]/);
  });
});
