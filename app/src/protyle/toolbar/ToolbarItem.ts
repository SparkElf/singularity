import {Constants} from "../../constants";
import {updateHotkeyTip} from "../util/keyboard";

type ToolbarMessageKey = Parameters<IProtyle["localization"]["text"]>[0];

export class ToolbarItem {
    public element: HTMLElement;

    constructor(protyle: IProtyle, menuItem: IMenuItem) {
        this.element = document.createElement("button");
        const hotkey = menuItem.hotkey ? ` ${updateHotkeyTip(menuItem.hotkey)}` : "";
        const tip = menuItem.tip || protyle.localization.text(menuItem.lang as ToolbarMessageKey);
        this.element.classList.add("protyle-toolbar__item", "b3-tooltips", `b3-tooltips__${menuItem.tipPosition}`);
        this.element.setAttribute("data-type", menuItem.name);
        this.element.setAttribute("aria-label", tip + hotkey);
        this.element.innerHTML = `<svg><use xlink:href="#${menuItem.icon}"></use></svg>`;
        if (["text", "a", "block-ref", "inline-math", "inline-memo"].includes(menuItem.name)) {
            return;
        }
        this.element.addEventListener("click", (event) => {
            event.preventDefault();
            if (Constants.INLINE_TYPE.includes(menuItem.name)) {
                protyle.toolbar.setInlineMark(protyle, menuItem.name, "toolbar");
            } else if (menuItem.click) {
                menuItem.click(protyle.getInstance());
            }
        });
    }
}
