import type { ProtyleEditorRegistry } from "./contracts.ts";

export function createProtyleEditorRegistry<TEditor>(): ProtyleEditorRegistry<TEditor> {
  interface Registration {
    readonly token: symbol;
    readonly unregister: () => void;
  }

  const editors = new Map<TEditor, Registration>();
  let active: TEditor | undefined;
  let sealed = false;
  let disposed = false;
  let initialActiveAssigned = false;

  const unregister = (editor: TEditor, token?: symbol) => {
    if (token && editors.get(editor)?.token !== token) {
      return;
    }
    if (!editors.delete(editor)) {
      return;
    }
    if (active === editor) {
      active = undefined;
    }
  };

  return {
    register: (editor) => {
      if (disposed) {
        throw new Error("[protyle.registry] cannot register an editor after disposal");
      }
      if (sealed) {
        throw new Error("[protyle.registry] cannot register an editor after sealing");
      }
      const existingRegistration = editors.get(editor);
      if (existingRegistration) {
        return existingRegistration.unregister;
      }
      const token = Symbol("protyle-editor-registration");
      const unregisterEditor = () => unregister(editor, token);
      editors.set(editor, { token, unregister: unregisterEditor });
      if (!initialActiveAssigned) {
        active = editor;
        initialActiveAssigned = true;
      }
      return unregisterEditor;
    },
    unregister,
    forEach: (visitor) => {
      editors.forEach((_registration, editor) => visitor(editor));
    },
    find: (predicate) => {
      for (const editor of editors.keys()) {
        if (predicate(editor)) {
          return editor;
        }
      }
      return undefined;
    },
    activate: (editor) => {
      if (!editors.has(editor)) {
        return false;
      }
      active = editor;
      return true;
    },
    getActive: () => active,
    seal: () => {
      sealed = true;
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      sealed = true;
      disposed = true;
      editors.clear();
      active = undefined;
    },
  };
}
