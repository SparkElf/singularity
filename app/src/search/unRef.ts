import {Constants} from "../constants";
import {fetchPost} from "../util/fetch";
import {setStorageVal} from "../protyle/util/compatibility";
import {getArticle, getAttr} from "./util";
import {EmbeddedProtyleOwner} from "../protyle/EmbeddedProtyleOwner";
import {escapeAriaLabel, escapeLessThans} from "../util/escape";
import {getIconByType} from "../protyle/util/getIconByType";
import {unicode2Emoji} from "../emoji";
import {getDisplayName, getNotebookName} from "../util/pathName";
import {Menu} from "../plugin/Menu";

export const openSearchUnRef = (element: HTMLElement, editor: EmbeddedProtyleOwner) => {
    window.siyuan.menus.menu.remove();
    element.previousElementSibling.previousElementSibling.classList.add("fn__none");
    element.classList.remove("fn__none");
    if (element.querySelector("#searchUnRefResult").innerHTML) {
        return;
    }
    const loadingElement =  element.parentElement.querySelector(".fn__loading") as HTMLElement;
    loadingElement.classList.remove("fn__none");
    loadingElement.style.top = "42px";
    if (element.querySelector("#searchUnRefList").innerHTML !== "") {
        return;
    }
    const localSearch = window.siyuan.storage[Constants.LOCAL_SEARCHUNREF] as ISearchAssetOption;
    if (localSearch.layout === 1) {
        if (localSearch.col) {
            editor.element.style.width = localSearch.col;
            editor.element.classList.remove("fn__flex-1");
        }
    } else {
        if (localSearch.row) {
            editor.element.classList.remove("fn__flex-1");
            editor.element.style.height = localSearch.row;
        }
    }

    const dragElement = element.querySelector(".search__drag");
    dragElement.addEventListener("mousedown", (event: MouseEvent) => {
        const documentSelf = document;
        const nextElement = dragElement.nextElementSibling as HTMLElement;
        const previousElement = dragElement.previousElementSibling as HTMLElement;
        const direction = localSearch.layout === 1 ? "lr" : "tb";
        const x = event[direction === "lr" ? "clientX" : "clientY"];
        const previousSize = direction === "lr" ? previousElement.clientWidth : previousElement.clientHeight;
        const nextSize = direction === "lr" ? nextElement.clientWidth : nextElement.clientHeight;

        nextElement.classList.remove("fn__flex-1");
        nextElement.style[direction === "lr" ? "width" : "height"] = nextSize + "px";
        element.style.userSelect = "none";
        documentSelf.onmousemove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            moveEvent.stopPropagation();
            const previousNowSize = (previousSize + (moveEvent[direction === "lr" ? "clientX" : "clientY"] - x));
            const nextNowSize = (nextSize - (moveEvent[direction === "lr" ? "clientX" : "clientY"] - x));
            if (previousNowSize < 120 || nextNowSize < 120) {
                return;
            }
            nextElement.style[direction === "lr" ? "width" : "height"] = nextNowSize + "px";
        };

        documentSelf.onmouseup = () => {
            element.style.userSelect = "";
            documentSelf.onmousemove = null;
            documentSelf.onmouseup = null;
            documentSelf.ondragstart = null;
            documentSelf.onselectstart = null;
            documentSelf.onselect = null;
            window.siyuan.storage[Constants.LOCAL_SEARCHUNREF][direction === "lr" ? "col" : "row"] = nextElement[direction === "lr" ? "clientWidth" : "clientHeight"] + "px";
            setStorageVal(Constants.LOCAL_SEARCHUNREF, window.siyuan.storage[Constants.LOCAL_SEARCHUNREF]);
            if (direction === "lr") {
                editor.resize();
            }
        };
    });
    dragElement.addEventListener("dblclick", () => {
        editor.element.style[localSearch.layout === 1 ? "width" : "height"] = "";
        editor.element.classList.add("fn__flex-1");
        const direction = localSearch.layout === 1 ? "lr" : "tb";
        window.siyuan.storage[Constants.LOCAL_SEARCHUNREF][direction === "lr" ? "col" : "row"] = "";
        setStorageVal(Constants.LOCAL_SEARCHUNREF, window.siyuan.storage[Constants.LOCAL_SEARCHUNREF]);
        if (direction === "lr") {
            editor.resize();
        }
    });
    getUnRefList(element, editor);
};

export const getUnRefList = (element: Element, edit: EmbeddedProtyleOwner, page = 1) => {
    if (edit.signal.aborted || !element.isConnected || !edit.element.isConnected) {
        return;
    }
    const ownerGeneration = edit.invalidate();
    const isCurrent = () => edit.isCurrentGeneration(ownerGeneration, element);
    const previousElement = element.querySelector('[data-type="unRefPrevious"]');
    if (page > 1) {
        previousElement.removeAttribute("disabled");
    } else {
        previousElement.setAttribute("disabled", "disabled");
    }
    fetchPost("/api/search/listInvalidBlockRefs", {
        page,
    }, (response) => {
        if (!isCurrent()) {
            return;
        }
        element.parentElement.querySelector(".fn__loading").classList.add("fn__none");
        const nextElement = element.querySelector('[data-type="unRefNext"]');
        if (page < response.data.pageCount) {
            nextElement.removeAttribute("disabled");
        } else {
            nextElement.setAttribute("disabled", "disabled");
        }
        let resultHTML = "";
        response.data.blocks.forEach((item: IBlock, index: number) => {
            if (!item.box) {
                throw new Error("[protyle.content] invalid block reference result requires a notebookId");
            }
            const title = getNotebookName(item.box) + getDisplayName(item.hPath, false);
            resultHTML += `<div data-type="search-item" class="b3-list-item${index === 0 ? " b3-list-item--focus" : ""}" data-node-id="${item.id}" data-root-id="${item.rootID}" data-notebook-id="${item.box}">
<svg class="b3-list-item__graphic"><use xlink:href="#${getIconByType(item.type)}"></use></svg>
${unicode2Emoji(item.ial.icon, "b3-list-item__graphic", true)}
<span class="b3-list-item__text">${item.content}</span>
${getAttr(item)}
<span class="b3-list-item__meta b3-list-item__meta--ellipsis ariaLabel" aria-label="${escapeAriaLabel(title)}">${escapeLessThans(title)}</span>
</div>`;
        });
        if (response.data.blocks.length > 0) {
            edit.element.classList.remove("fn__none");
            element.querySelector(".search__drag")?.classList.remove("fn__none");
            getArticle({
                edit,
                id: response.data.blocks[0].id,
                notebookId: response.data.blocks[0].box,
            });
        } else {
            edit.clear();
            edit.element.classList.add("fn__none");
            element.querySelector(".search__drag")?.classList.add("fn__none");
        }
        element.querySelector("#searchUnRefResult").innerHTML = `${page}/${response.data.pageCount || 1}<span class="fn__space"></span>
<span class="ft__on-surface">${window.siyuan.languages.findInDoc.replace("${x}", response.data.matchedRootCount).replace("${y}", response.data.matchedBlockCount)}</span>`;
        element.querySelector("#searchUnRefList").innerHTML = resultHTML || `<div class="search__empty">
    ${window.siyuan.languages.emptyContent}
</div>`;
    }, undefined, undefined, ownerGeneration.signal);
};

export const unRefMoreMenu = (target: Element, element: Element, edit: EmbeddedProtyleOwner) => {
    const menu = new Menu(Constants.MENU_SEARCH_UNREF_MORE);
    if (menu.isOpen) {
        return;
    }
    const localData = window.siyuan.storage[Constants.LOCAL_SEARCHUNREF];
    /// #if !MOBILE
    menu.addItem({
        icon: "iconLayout",
        label: window.siyuan.languages.layout,
        type: "submenu",
        submenu: [{
            iconHTML: "",
            label: window.siyuan.languages.topBottomLayout,
            current: localData.layout === 0,
            click() {
                element.querySelector(".search__layout").classList.remove("search__layout--row");
                edit.element.style.width = "";
                if (localData.row) {
                    edit.element.style.height = localData.row;
                    edit.element.classList.remove("fn__flex-1");
                } else {
                    edit.element.classList.add("fn__flex-1");
                }
                edit.resize();
                localData.layout = 0;
                setStorageVal(Constants.LOCAL_SEARCHUNREF, window.siyuan.storage[Constants.LOCAL_SEARCHUNREF]);
            }
        }, {
            iconHTML: "",
            label: window.siyuan.languages.leftRightLayout,
            current: localData.layout === 1,
            click() {
                element.querySelector(".search__layout").classList.add("search__layout--row");
                edit.element.style.height = "";
                if (localData.col) {
                    edit.element.style.width = localData.col;
                    edit.element.classList.remove("fn__flex-1");
                } else {
                    edit.element.classList.add("fn__flex-1");
                }
                edit.resize();
                localData.layout = 1;
                setStorageVal(Constants.LOCAL_SEARCHUNREF, window.siyuan.storage[Constants.LOCAL_SEARCHUNREF]);
            }
        }]
    });
    /// #endif
    menu.addItem({
        icon: "iconRefresh",
        label: window.siyuan.languages.refresh,
        click() {
            const loadingElement =  element.parentElement.querySelector(".fn__loading") as HTMLElement;
            loadingElement.classList.remove("fn__none");
            loadingElement.style.top = "42px";
            getUnRefList(element, edit);
        },
    });
    /// #if MOBILE
    menu.fullscreen();
    /// #else
    const rect = target.getBoundingClientRect();
    menu.open({x: rect.right, y: rect.bottom, isLeft: true});
    /// #endif
};
