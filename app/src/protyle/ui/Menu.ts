import type {
    ProtyleLocalizationPort,
    ProtyleMenuItem,
    ProtyleMenuPosition,
    ProtyleMenuSurface,
} from "../../../../enterprise/packages/protyle-browser/src/contracts";

export interface ProtyleDOMMenuDependencies {
    readonly formatHotkey: (hotkey: string) => string;
    readonly isNarrowViewport: () => boolean;
    readonly localization: ProtyleLocalizationPort;
    readonly portalRoot: HTMLElement;
    readonly requestClose: () => void;
}

const closestMenuItem = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(".b3-menu__item") : null;

export class ProtyleDOMMenu implements ProtyleMenuSurface {
    public readonly element: HTMLElement;
    public data: unknown;
    public removeCB: (() => void) | undefined;

    private readonly controller = new AbortController();
    private readonly dependencies: ProtyleDOMMenuDependencies;
    private readonly itemsElement: HTMLElement;
    private position: ProtyleMenuPosition | undefined;

    constructor(dependencies: ProtyleDOMMenuDependencies) {
        this.dependencies = dependencies;
        this.element = document.createElement("div");
        this.element.className = "b3-menu fn__none";
        this.element.dataset.protyleMenu = "";
        this.element.setAttribute("role", "menu");
        this.element.style.position = "fixed";

        const title = document.createElement("button");
        title.className = "b3-menu__title fn__none";
        title.type = "button";
        title.innerHTML = '<svg class="b3-menu__icon"><use xlink:href="#iconLeft"></use></svg>';
        const titleLabel = document.createElement("span");
        titleLabel.className = "b3-menu__label";
        titleLabel.textContent = dependencies.localization.text("back");
        title.append(titleLabel);

        this.itemsElement = document.createElement("div");
        this.itemsElement.className = "b3-menu__items";
        this.element.append(title, this.itemsElement);
        dependencies.portalRoot.append(this.element);

        this.element.addEventListener(
            dependencies.isNarrowViewport() ? "click" : "mouseover",
            (event) => this.handlePointer(event),
            {signal: this.controller.signal},
        );
        title.addEventListener("click", () => this.back(), {signal: this.controller.signal});
    }

    public addItem(item: ProtyleMenuItem): HTMLElement | undefined {
        if (item.ignore) {
            return undefined;
        }
        const element = this.createItem(item);
        this.append(element, item.index);
        return element;
    }

    public append(element: HTMLElement, index?: number): void {
        if (typeof index === "number") {
            const separator = this.itemsElement.querySelectorAll(":scope > .b3-menu__separator")[index];
            if (separator) {
                separator.before(element);
                return;
            }
        }
        this.itemsElement.append(element);
    }

    public close(): void {
        this.dependencies.requestClose();
    }

    public dispose(): void {
        const removeCB = this.removeCB;
        this.removeCB = undefined;
        try {
            removeCB?.();
        } finally {
            this.controller.abort();
            this.element.remove();
            this.data = undefined;
        }
    }

    public fullscreen(position: "all" | "bottom" = "all"): void {
        if (!this.itemsElement.hasChildNodes()) {
            return;
        }
        this.position = undefined;
        this.element.classList.add("b3-menu--fullscreen");
        this.element.classList.remove("fn__none");
        this.element.firstElementChild?.classList.remove("fn__none");
        this.itemsElement.scrollTop = 0;
        this.element.style.height = position === "bottom" ? "50vh" : "100%";
        this.element.style.transform = position === "bottom"
            ? "translateY(-50vh)"
            : "translateY(-100%)";
        this.element.style.width = "100%";
        this.element.style.left = "0";
        this.element.style.top = "100%";
        this.element.style.right = "0";
        this.element.style.bottom = "auto";
        this.bringToFront();
    }

    public popup(position: ProtyleMenuPosition): void {
        if (!this.itemsElement.hasChildNodes()) {
            return;
        }
        this.position = position;
        this.element.classList.remove("fn__none", "b3-menu--fullscreen");
        this.element.firstElementChild?.classList.add("fn__none");
        this.element.style.height = "";
        this.element.style.transform = "";
        this.element.style.width = "";
        this.element.style.right = "";
        this.element.style.bottom = "";
        this.bringToFront();
        this.positionPopup(position);
        this.updateMaxHeight(this.element, this.itemsElement);
    }

    public resetPosition(): void {
        if (!this.position || this.element.classList.contains("fn__none")) {
            return;
        }
        this.positionPopup(this.position);
        this.updateMaxHeight(this.element, this.itemsElement);
        this.element.querySelectorAll<HTMLElement>(".b3-menu__item--show > .b3-menu__submenu")
            .forEach((submenu) => this.showSubMenu(submenu));
    }

    public showSubMenu(submenu: HTMLElement): void {
        const items = submenu.lastElementChild as HTMLElement | null;
        const parent = submenu.parentElement;
        if (!items || !parent) {
            return;
        }
        items.style.maxHeight = "";
        const parentRect = parent.getBoundingClientRect();
        const submenuRect = submenu.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        submenu.style.top = `${Math.max(
            0,
            Math.min(parentRect.top - 9, viewportHeight - submenuRect.height - 1),
        )}px`;
        const right = parentRect.right + 8;
        const left = parentRect.left - submenuRect.width - 8;
        submenu.style.left = `${right + submenuRect.width <= viewportWidth ? right : Math.max(0, left)}px`;
        this.updateMaxHeight(submenu, items);
    }

    private back(): void {
        const shown = this.element.querySelectorAll<HTMLElement>(".b3-menu__item--show");
        const current = shown.item(shown.length - 1);
        if (current) {
            current.classList.remove("b3-menu__item--show");
            return;
        }
        this.close();
    }

    private bringToFront(): void {
        this.dependencies.portalRoot.append(this.element);
    }

    private createItem(item: ProtyleMenuItem): HTMLElement {
        if (item.type === "empty") {
            const custom = document.createElement("div");
            custom.innerHTML = item.label ?? "";
            item.bind?.(custom);
            return custom;
        }

        const element = document.createElement("button");
        element.type = "button";
        if (item.disabled) {
            element.disabled = true;
        }
        if (item.id) {
            element.dataset.id = item.id;
        }
        if (item.type === "separator") {
            element.className = "b3-menu__separator";
            element.setAttribute("role", "separator");
            return element;
        }
        element.className = "b3-menu__item";
        element.setAttribute("role", "menuitem");
        element.classList.toggle("b3-menu__item--selected", item.current === true);
        element.classList.toggle("b3-menu__item--readonly", item.type === "readonly");
        element.classList.toggle(
            "b3-menu__item--warning",
            item.warning === true || item.icon === "iconTrashcan",
        );

        if (item.element) {
            element.append(item.element);
        } else {
            if (item.iconHTML) {
                element.insertAdjacentHTML("beforeend", item.iconHTML);
            } else {
                const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                icon.setAttribute("class", `b3-menu__icon ${item.iconClass ?? ""}`.trim());
                const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
                use.setAttribute("href", `#${item.icon ?? ""}`);
                icon.append(use);
                element.append(icon);
            }
            const label = document.createElement("span");
            label.className = "b3-menu__label";
            label.innerHTML = item.label ?? "&nbsp;";
            element.append(label);
            if (item.accelerator) {
                const accelerator = document.createElement("span");
                accelerator.className = "b3-menu__accelerator b3-menu__accelerator--hotkey";
                accelerator.textContent = this.dependencies.formatHotkey(item.accelerator);
                element.append(accelerator);
            }
            if (item.action) {
                const action = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                action.setAttribute(
                    "class",
                    `b3-menu__action${item.action === "iconCloseRound" ? " b3-menu__action--close" : ""}`,
                );
                const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
                use.setAttribute("href", `#${item.action}`);
                action.append(use);
                element.append(action);
            }
            if (item.checked) {
                const checked = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                checked.setAttribute("class", "b3-menu__checked");
                const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
                use.setAttribute("href", "#iconSelect");
                checked.append(use);
                element.append(checked);
            }
        }

        if (item.bind) {
            element.classList.add("b3-menu__item--custom");
            item.bind(element);
        }
        if (item.submenu) {
            const submenu = document.createElement("div");
            submenu.className = "b3-menu__submenu";
            const submenuItems = document.createElement("div");
            submenuItems.className = "b3-menu__items";
            item.submenu.forEach((child) => {
                if (!child.ignore) {
                    submenuItems.append(this.createItem(child));
                }
            });
            submenu.append(submenuItems);
            const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            arrow.setAttribute("class", "b3-menu__icon b3-menu__icon--small");
            const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
            use.setAttribute("href", "#iconRight");
            arrow.append(use);
            element.append(arrow, submenu);
        }
        if (item.click) {
            element.addEventListener("click", (event) => {
                if (element.disabled) {
                    return;
                }
                const keepOpen = item.click?.(element, event);
                event.preventDefault();
                event.stopPropagation();
                if (keepOpen instanceof Promise) {
                    void keepOpen.catch((error) => {
                        console.error("[protyle.menu] item action failed", error);
                    });
                }
                if (keepOpen !== true) {
                    this.close();
                }
            }, {signal: this.controller.signal});
        }
        return element;
    }

    private handlePointer(event: Event): void {
        const item = closestMenuItem(event.target);
        if (!item || !this.element.contains(item) ||
            item.classList.contains("b3-menu__item--readonly")) {
            return;
        }
        this.element.querySelectorAll<HTMLElement>(".b3-menu__item--show").forEach((shown) => {
            if (shown !== item && !shown.contains(item) && !item.contains(shown)) {
                shown.classList.remove("b3-menu__item--show");
            }
        });
        this.element.querySelectorAll(".b3-menu__item--current")
            .forEach((current) => current.classList.remove("b3-menu__item--current"));
        item.classList.add("b3-menu__item--current");
        const submenu = item.querySelector<HTMLElement>(":scope > .b3-menu__submenu");
        if (submenu) {
            item.classList.add("b3-menu__item--show");
            if (!this.element.classList.contains("b3-menu--fullscreen")) {
                this.showSubMenu(submenu);
            }
        }
    }

    private positionPopup(position: ProtyleMenuPosition): void {
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const width = this.element.getBoundingClientRect().width;
        const height = this.element.getBoundingClientRect().height;
        let left = position.x - (position.isLeft ? width : 0);
        let top = position.y;
        if (top + height > viewportHeight) {
            const above = position.y - height - (position.h ?? 0);
            top = above >= 0 ? above : Math.max(0, viewportHeight - height);
        }
        if (left + width > viewportWidth) {
            left = viewportWidth - width - (position.w ?? 0);
        }
        this.element.style.left = `${Math.max(0, left)}px`;
        this.element.style.top = `${Math.max(0, top)}px`;
    }

    private updateMaxHeight(menu: HTMLElement, items: HTMLElement): void {
        items.style.maxHeight = `${Math.max(
            document.documentElement.clientHeight - menu.getBoundingClientRect().top - 18,
            30,
        )}px`;
    }
}
