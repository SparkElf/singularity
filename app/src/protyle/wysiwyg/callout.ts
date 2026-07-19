import {Constants} from "../../constants";
import {unicodeToEmoji} from "../hint/emoji";
import {openProtyleEmojiMenu} from "../ui/emojiMenu";
import {focusByRange} from "../util/selection";
import {openProtyleDialog} from "./dialogOwner";
import {transaction} from "./transaction";

type CalloutMenuHandle = ReturnType<TProtyleRuntime["menu"]["open"]>;

interface ActiveCalloutMenu {
    readonly handle: CalloutMenuHandle;
    readonly kind: "emoji" | "type";
}

const CALLOUT_TYPES = [{
    icon: "✏️",
    type: "Note",
    color: "var(--b3-callout-note)",
}, {
    icon: "💡",
    type: "Tip",
    color: "var(--b3-callout-tip)",
}, {
    icon: "❗",
    type: "Important",
    color: "var(--b3-callout-important)",
}, {
    icon: "⚠️",
    type: "Warning",
    color: "var(--b3-callout-warning)",
}, {
    icon: "🚨",
    type: "Caution",
    color: "var(--b3-callout-caution)",
}] as const;

const createSpacer = () => {
    const spacer = document.createElement("span");
    spacer.className = "fn__space";
    return spacer;
};

const createDivider = (className = "fn__hr") => {
    const divider = document.createElement("div");
    divider.className = className;
    return divider;
};

export const updateCalloutType = (blockElements: HTMLElement[], protyle: IProtyle) => {
    if (blockElements.length === 0) {
        return;
    }
    const localization = protyle.localization;
    const selection = getSelection();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const blockCalloutElement = blockElements[0].querySelector<HTMLElement>(".callout-icon")!;
    const dialog = openProtyleDialog({
        protyle,
        title: localization.text("callout"),
        onClose: () => {
            if (range && !protyle.requestSignal.aborted) {
                focusByRange(range);
            }
        },
    });

    const content = document.createElement("div");
    content.className = "b3-dialog__content";
    const iconRow = document.createElement("label");
    iconRow.className = "fn__flex";
    const iconLabel = document.createElement("div");
    iconLabel.className = "fn__flex-center";
    iconLabel.textContent = localization.text("icon");
    const iconEditor = document.createElement("div");
    iconEditor.className = "protyle-wysiwyg";
    iconEditor.style.padding = "0";
    iconEditor.contentEditable = "false";
    const dialogCalloutIconElement = document.createElement("span");
    dialogCalloutIconElement.className = "callout-icon";
    dialogCalloutIconElement.innerHTML = blockCalloutElement.innerHTML;
    iconEditor.append(dialogCalloutIconElement);
    iconRow.append(iconLabel, createSpacer(), iconEditor);

    const typeRow = document.createElement("label");
    typeRow.className = "fn__flex";
    const typeLabel = document.createElement("div");
    typeLabel.className = "fn__flex-center";
    typeLabel.textContent = localization.text("type");
    const typeControl = document.createElement("div");
    typeControl.className = "b3-form__icona fn__flex-1";
    typeControl.style.overflow = "visible";
    const typeInput = document.createElement("input");
    typeInput.type = "text";
    typeInput.className = "b3-text-field fn__block b3-form__icona-input";
    typeInput.value = blockElements[0].getAttribute("data-subtype") ?? "";
    const typeButton = document.createElement("button");
    typeButton.type = "button";
    typeButton.className = "b3-form__icona-icon block__icon block__icon--show";
    typeButton.setAttribute("aria-label", localization.text("type"));
    typeButton.innerHTML = '<svg><use href="#iconDown"></use></svg>';
    typeControl.append(typeInput, typeButton);
    typeRow.append(typeLabel, createSpacer(), typeControl);

    const titleRow = document.createElement("label");
    titleRow.className = "fn__flex";
    const titleLabel = document.createElement("div");
    titleLabel.className = "fn__flex-center";
    titleLabel.textContent = localization.text("title");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "b3-text-field fn__flex-1";
    titleRow.append(titleLabel, createSpacer(), titleInput);
    content.append(iconRow, createDivider(), typeRow, createDivider(), titleRow);

    const actions = document.createElement("div");
    actions.className = "b3-dialog__action";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "b3-button b3-button--cancel";
    cancelButton.textContent = localization.text("cancel");
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "b3-button b3-button--text";
    confirmButton.textContent = localization.text("confirm");
    actions.append(cancelButton, createSpacer(), confirmButton);
    dialog.bodyElement.append(content, actions);

    let activeMenu: ActiveCalloutMenu | undefined;
    const closeActiveMenu = () => activeMenu?.handle.close();
    dialog.signal.addEventListener("abort", closeActiveMenu, {once: true});
    const ownMenu = (handle: CalloutMenuHandle, kind: ActiveCalloutMenu["kind"]) => {
        const state: ActiveCalloutMenu = {handle, kind};
        const previousRemove = handle.menu.removeCB;
        activeMenu = state;
        handle.menu.removeCB = () => {
            previousRemove?.();
            if (activeMenu === state) {
                activeMenu = undefined;
            }
        };
        return state;
    };

    cancelButton.addEventListener("click", dialog.close, {signal: dialog.signal});
    confirmButton.addEventListener("click", () => {
        const doOperations: IOperation[] = [];
        const undoOperations: IOperation[] = [];
        const type = typeInput.value.trim();
        blockElements.forEach((item) => {
            const id = item.getAttribute("data-node-id");
            const oldHTML = item.outerHTML;
            item.setAttribute("data-subtype", type);
            let title = titleInput.value.trim();
            if (title) {
                const template = document.createElement("template");
                template.innerHTML = protyle.lute.Md2BlockDOM(title);
                title = template.content.firstElementChild!.firstElementChild!.innerHTML;
            }
            item.querySelector<HTMLElement>(".callout-title")!.innerHTML = title ||
                (type.substring(0, 1).toUpperCase() + type.substring(1).toLowerCase());
            item.querySelector<HTMLElement>(".callout-icon")!.innerHTML = dialogCalloutIconElement.innerHTML;
            item.setAttribute(Constants.ATTRIBUTE_EDITING, "true");
            doOperations.push({id, data: item.outerHTML, action: "update"});
            undoOperations.push({id, data: oldHTML, action: "update"});
        });
        transaction(protyle, doOperations, undoOperations);
        dialog.close();
    }, {signal: dialog.signal});
    titleInput.addEventListener("keydown", (event) => {
        if (!event.isComposing && !event.repeat && event.key === "Enter" &&
            !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            confirmButton.click();
            event.preventDefault();
            event.stopPropagation();
        }
    }, {signal: dialog.signal});

    const openTypeMenu = () => {
        if (activeMenu?.kind === "type") {
            activeMenu.handle.close();
            return;
        }
        closeActiveMenu();
        const runtime = protyle.session!.runtime as TProtyleRuntime;
        const state = ownMenu(runtime.menu.open(), "type");
        CALLOUT_TYPES.forEach((item) => {
            state.handle.menu.addItem({
                iconHTML: `<span class="b3-menu__icon">${item.icon}</span>`,
                label: `<span style="color: ${item.color}">${item.type}</span>`,
                click() {
                    if (typeInput.value.toLowerCase() === titleInput.value.toLowerCase()) {
                        titleInput.value = item.type;
                    }
                    typeInput.value = item.type.toUpperCase();
                    dialogCalloutIconElement.innerHTML = item.icon;
                    titleInput.focus();
                    titleInput.select();
                },
            });
        });
        state.handle.menu.removeCB = (() => {
            const remove = state.handle.menu.removeCB;
            return () => {
                remove?.();
                if (!dialog.signal.aborted && document.activeElement === document.body) {
                    typeInput.focus();
                }
            };
        })();
        const inputRect = typeInput.getBoundingClientRect();
        state.handle.menu.popup({x: inputRect.left, y: inputRect.bottom});
    };
    typeButton.addEventListener("click", (event) => {
        openTypeMenu();
        event.preventDefault();
        event.stopPropagation();
    }, {signal: dialog.signal});
    typeInput.addEventListener("keydown", (event) => {
        if (event.isComposing) {
            return;
        }
        if (event.key.startsWith("Arrow")) {
            openTypeMenu();
            typeInput.blur();
            event.preventDefault();
            event.stopPropagation();
        }
    }, {signal: dialog.signal});

    dialogCalloutIconElement.addEventListener("click", () => {
        closeActiveMenu();
        const emojiRect = dialogCalloutIconElement.getBoundingClientRect();
        const handle = openProtyleEmojiMenu({
            protyle,
            position: {
                x: emojiRect.left,
                y: emojiRect.bottom,
                h: emojiRect.height,
                w: emojiRect.width,
            },
            onSelect: (unicode, menuSignal) => {
                if (dialog.signal.aborted || menuSignal.aborted) {
                    return;
                }
                let emojiHTML = unicodeToEmoji(protyle, unicode, "callout-img");
                if (unicode === "") {
                    const defaultType = CALLOUT_TYPES.find((item) => item.type.toUpperCase() === typeInput.value);
                    if (defaultType) {
                        emojiHTML = defaultType.icon;
                    }
                }
                dialogCalloutIconElement.innerHTML = emojiHTML;
            },
        });
        if (handle) {
            ownMenu(handle, "emoji");
        }
    }, {signal: dialog.signal});

    titleInput.value = protyle.lute.BlockDOM2StdMd(
        blockElements[0].querySelector<HTMLElement>(".callout-title")!.innerHTML,
    );
    typeInput.focus();
    typeInput.select();
};
