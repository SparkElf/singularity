import type {
  ProtylePluginEvent,
  ProtylePluginPort,
  ProtylePluginSlashItem,
} from "./contracts.ts";

export interface ProtylePluginCommand<TEditor> {
  readonly [key: string]: unknown;
  readonly hotkey: string;
  readonly run: (editor: TEditor, event: KeyboardEvent) => void;
}

/**
 * 保留斜杠项原对象，让 Core 直接读取插件扩展字段，不新增归一化或身份映射。
 */
export interface ProtylePluginSlashContribution<TEditor>
  extends ProtylePluginSlashItem {
  readonly [key: string]: unknown;
  readonly run: (editor: TEditor, nodeElement: HTMLElement) => void;
}

export interface ProtylePluginContribution<TOptions, TToolbar, TEditor> {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly extendOptions?: (options: TOptions) => TOptions;
  readonly extendToolbar?: (toolbar: TToolbar) => TToolbar;
  readonly onEvent?: <TDetail extends object>(
    event: ProtylePluginEvent<TDetail>,
  ) => void;
  readonly commands?: readonly ProtylePluginCommand<TEditor>[];
  readonly slashItems?: readonly ProtylePluginSlashContribution<TEditor>[];
  readonly transformPaste?: <TPayload extends object>(
    editor: TEditor,
    payload: TPayload,
  ) =>
    | void
    | Partial<TPayload>
    | Promise<void | Partial<TPayload>>;
  readonly dispose?: () => void | Promise<void>;
}

/** 创建插件能力端口，按声明顺序执行扩展并在销毁时尝试释放全部插件。 */
function createPluginPort<
  TOptions,
  TToolbar,
  TEditor,
>(contributions: readonly ProtylePluginContribution<TOptions, TToolbar, TEditor>[]):
  ProtylePluginPort<TOptions, TToolbar, TEditor> {
  const names = new Set<string>();
  contributions.forEach((contribution) => {
    if (names.has(contribution.name)) {
      throw new Error(`[protyle.plugins] duplicate plugin name: ${contribution.name}`);
    }
    names.add(contribution.name);
  });

  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const assertActive = () => {
    if (disposed) {
      throw new Error("[protyle.plugins] cannot use the plugin port after disposal");
    }
  };

  const dispose = () => {
    if (disposePromise) {
      return disposePromise;
    }
    disposed = true;
    disposePromise = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const contribution of contributions) {
        try {
          await contribution.dispose?.();
        } catch (error) {
          console.error("[protyle.plugins] contribution disposal failed", error);
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "[protyle.plugins] disposal failed");
      }
    });
    return disposePromise;
  };

  return {
    extendOptions: (options) => {
      assertActive();
      let current = options;
      for (const contribution of contributions) {
        if (contribution.extendOptions) {
          current = contribution.extendOptions(current);
        }
      }
      return current;
    },
    extendToolbar: (toolbar, normalizeToolbar) => {
      assertActive();
      let current = toolbar;
      for (const contribution of contributions) {
        if (contribution.extendToolbar) {
          current = normalizeToolbar(contribution.extendToolbar(current));
        }
      }
      return current;
    },
    emit: (event) => {
      assertActive();
      for (const contribution of contributions) {
        contribution.onEvent?.(event);
      }
    },
    runEditorCommand: (editor, event, matchesHotkey) => {
      assertActive();
      for (const contribution of contributions) {
        for (const command of contribution.commands ?? []) {
          if (!matchesHotkey(command.hotkey, event)) {
            continue;
          }
          command.run(editor, event);
          return true;
        }
      }
      return false;
    },
    forEachSlashItem: (visitor) => {
      assertActive();
      for (const contribution of contributions) {
        for (const item of contribution.slashItems ?? []) {
          visitor(contribution.name, item);
        }
      }
    },
    runSlashItem: (pluginName, selectedItem, editor, nodeElement) => {
      assertActive();
      for (const contribution of contributions) {
        if (contribution.name !== pluginName) {
          continue;
        }
        for (const item of contribution.slashItems ?? []) {
          if (item === selectedItem) {
            item.run(editor, nodeElement);
            return true;
          }
        }
        return false;
      }
      return false;
    },
    transformPaste: async (editor, payload) => {
      assertActive();
      let current = payload;
      let copied = false;
      for (const contribution of contributions) {
        if (!contribution.transformPaste) {
          continue;
        }
        assertActive();
        if (!copied) {
          // 粘贴载荷由调用方持有；只做一次浅拷贝，保留插件扩展字段并避免修改源对象。
          current = {...payload};
          copied = true;
        }
        const result = await contribution.transformPaste(editor, current);
        assertActive();
        if (result !== undefined) {
          Object.assign(current, result);
        }
      }
      return current;
    },
    dispose,
  };
}

/** 创建带至少一个声明的插件端口，禁止重复插件身份并保留扩展字段。 */
export function createProtylePluginPort<
  TOptions,
  TToolbar,
  TEditor,
>(
  contributions: readonly [
    ProtylePluginContribution<TOptions, TToolbar, TEditor>,
    ...ProtylePluginContribution<TOptions, TToolbar, TEditor>[],
  ],
): ProtylePluginPort<TOptions, TToolbar, TEditor> {
  return createPluginPort(contributions);
}

/** 创建无插件端口，用于本地或测试运行时复用同一能力合同。 */
export function createEmptyProtylePluginPort<TOptions, TToolbar, TEditor>(): ProtylePluginPort<
  TOptions,
  TToolbar,
  TEditor
> {
  return createPluginPort<TOptions, TToolbar, TEditor>([]);
}
