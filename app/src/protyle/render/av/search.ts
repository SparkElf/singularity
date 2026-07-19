import {focusBlock} from "../../util/selection";

const collapseAvSearch = (searchInputElement: HTMLElement, viewsElement: HTMLElement) => {
    viewsElement.classList.remove("av__views--show");
    searchInputElement.style.width = "0";
    searchInputElement.style.paddingLeft = "0";
    searchInputElement.style.marginRight = "0";
};

export const bindAvSearch = (options: {
    blockElement: HTMLElement,
    clearLabel: string,
    query?: string,
    isSearching?: boolean,
    onChange: () => void,
}) => {
    const viewsElement = options.blockElement.querySelector(".av__views") as HTMLElement;
    const searchInputElement = options.blockElement.querySelector('[data-type="av-search"]') as HTMLElement;
    searchInputElement.textContent = options.query || "";
    if (options.isSearching) {
        searchInputElement.focus();
    }
    searchInputElement.addEventListener("compositionstart", (event: KeyboardEvent) => {
        event.stopPropagation();
    });
    const searchInputChange = (event: Event) => {
        event.stopPropagation();
        if ((event as KeyboardEvent).isComposing) {
            return;
        }
        if (searchInputElement.textContent || document.activeElement === searchInputElement) {
            viewsElement.classList.add("av__views--show");
        } else {
            viewsElement.classList.remove("av__views--show");
        }
        options.onChange();
    };
    searchInputElement.addEventListener("input", searchInputChange);
    // 剪切不会触发 input
    searchInputElement.addEventListener("cut", (event) => {
        setTimeout(() => {
            searchInputChange(event);
        });
    });
    searchInputElement.addEventListener("compositionend", () => {
        options.onChange();
    });
    searchInputElement.addEventListener("blur", (event: KeyboardEvent) => {
        if (event.isComposing) {
            return;
        }
        if (!searchInputElement.textContent) {
            collapseAvSearch(searchInputElement, viewsElement);
        }
    });
    const clearElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    clearElement.classList.add("b3-form__icon-clear", "ariaLabel");
    clearElement.setAttribute("aria-label", options.clearLabel);
    clearElement.style.width = "1em";
    clearElement.style.height = `${searchInputElement.clientHeight}px`;
    clearElement.innerHTML = '<use href="#iconCloseRound"></use>';
    searchInputElement.after(clearElement);
    const updateClear = () => {
        const empty = searchInputElement.textContent === "";
        clearElement.classList.toggle("fn__none", empty);
        if (empty) {
            searchInputElement.style.removeProperty("margin-right");
        } else {
            searchInputElement.style.setProperty("margin-right", `${clearElement.clientWidth}px`, "important");
        }
    };
    clearElement.addEventListener("click", () => {
        searchInputElement.textContent = "";
        searchInputElement.focus();
        updateClear();
        collapseAvSearch(searchInputElement, viewsElement);
        focusBlock(options.blockElement);
        options.onChange();
    });
    searchInputElement.addEventListener("input", updateClear);
    searchInputElement.addEventListener("cut", () => setTimeout(updateClear));
    updateClear();
};
