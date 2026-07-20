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

const focusedBlockIds = new Map<HTMLElement, string>();
const focusObservers = new Map<HTMLElement, MutationObserver>();

/** 在事务重建块 DOM 后恢复会话态焦点 class，展示状态不进入持久化 HTML。 */
function restoreFocusedBlock(editorRoot: HTMLElement): void {
  const blockId = focusedBlockIds.get(editorRoot);
  if (!blockId) {
    return;
  }
  const block = Array.from(editorRoot.querySelectorAll<HTMLElement>("[data-node-id]")).find(
    (candidate) => candidate.getAttribute("data-node-id") === blockId,
  );
  block?.classList.add("protyle-wysiwyg--hl");
}

/** 聚焦块并按编辑器根隔离状态，避免不同内容会话共享插件展示态。 */
function focusBlock(element: Element): void {
  const block = element.closest<HTMLElement>("[data-node-id]") ?? element;
  const editorRoot = block.closest<HTMLElement>(".protyle-wysiwyg");
  if (!editorRoot) {
    block.classList.add("protyle-wysiwyg--hl");
    return;
  }
  const blockId = block.getAttribute("data-node-id");
  if (!blockId) {
    return;
  }
  focusedBlockIds.set(editorRoot, blockId);
  block.classList.add("protyle-wysiwyg--hl");
  if (!focusObservers.has(editorRoot)) {
    const observer = new MutationObserver(() => restoreFocusedBlock(editorRoot));
    observer.observe(editorRoot, {childList: true, subtree: true});
    focusObservers.set(editorRoot, observer);
  }
}

/** 键盘命令聚焦当前选区所属块；事件目标可能是编辑器根容器，不能只查其祖先。 */
function focusBlockFromKeyboard(event: KeyboardEvent): void {
  if (!(event.target instanceof Element)) {
    return;
  }
  const anchor = window.getSelection()?.anchorNode;
  const selectionBlock = anchor instanceof Element
    ? anchor.closest("[data-node-id]")
    : anchor?.parentElement?.closest("[data-node-id]");
  const block = event.target.closest("[data-node-id]") ?? selectionBlock;
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
    dispose: () => {
      focusObservers.forEach((observer) => observer.disconnect());
      focusObservers.clear();
      focusedBlockIds.clear();
    },
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
