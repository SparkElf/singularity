import type {
  ProtyleController,
  ProtyleMenuItem,
  ProtylePluginContribution,
  ProtylePluginEvent,
} from "@singularity/protyle-browser";

export const REACT_PROTYLE_PLUGIN_NAME = "singularity-react";
export const REACT_PROTYLE_PLUGIN_FOCUS_LABEL = "聚焦当前块";
export const REACT_PROTYLE_PLUGIN_FOCUS_HOTKEY = "⌥⇧M";
export const REACT_PROTYLE_PLUGIN_FOCUS_SLASH_ID = "singularity-focus-block";

interface PluginMenuSubmenu {
  readonly addItem: (item: ProtyleMenuItem) => unknown;
}

interface ContentMenuPluginDetail {
  readonly element: Element;
  readonly menu: PluginMenuSubmenu;
}

type ReactProtylePlugin = ProtylePluginContribution<
  unknown,
  unknown,
  ProtyleController
>;

function focusBlock(element: Element): void {
  element.classList.add("protyle-wysiwyg--hl");
}

function focusBlockFromKeyboard(event: KeyboardEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }
  const block = event.target.closest("[data-node-id]");
  if (block) {
    focusBlock(block);
  }
}

function contributeContentMenu<TDetail extends object>(
  event: ProtylePluginEvent<TDetail>,
): void {
  if (event.type !== "open-menu-content") {
    return;
  }
  const detail = event.detail as ContentMenuPluginDetail;
  detail.menu.addItem({
    click: () => focusBlock(detail.element),
    icon: "iconFocus",
    id: "singularity-focus-block",
    label: REACT_PROTYLE_PLUGIN_FOCUS_LABEL,
  });
}

const transformPaste = async <TPayload extends object>(
  _editor: ProtyleController,
  payload: TPayload,
): Promise<Partial<TPayload> | undefined> => {
  const current = payload as TPayload & { readonly textPlain: string };
  if (!current.textPlain.includes("\u00a0")) {
    return undefined;
  }
  await Promise.resolve();
  return {
    textPlain: current.textPlain.replaceAll("\u00a0", " "),
  } as unknown as Partial<TPayload>;
};

function createReactProtylePlugin(): ReactProtylePlugin {
  return {
    commands: [
      {
        hotkey: REACT_PROTYLE_PLUGIN_FOCUS_HOTKEY,
        run: (_editor, event) => focusBlockFromKeyboard(event),
      },
    ],
    name: REACT_PROTYLE_PLUGIN_NAME,
    onEvent: contributeContentMenu,
    slashItems: [
      {
        filter: ["focus", "聚焦", REACT_PROTYLE_PLUGIN_FOCUS_LABEL],
        html: `<div class="b3-list-item__first"><span class="b3-list-item__text">${
          REACT_PROTYLE_PLUGIN_FOCUS_LABEL
        }</span></div>`,
        id: REACT_PROTYLE_PLUGIN_FOCUS_SLASH_ID,
        run: (_editor, nodeElement) => focusBlock(nodeElement),
      },
    ],
    transformPaste,
  };
}

/**
 * 浏览器 Session 持有唯一贡献源；非空元组保证生产装配有真实能力，公共端口仍可在后续阶段扩展声明。
 */
export function createReactProtylePluginContributions(): readonly [
  ReactProtylePlugin,
] {
  return [createReactProtylePlugin()];
}
