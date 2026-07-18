import * as dayjs from "dayjs";
import {EmbeddedProtyleOwner} from "../protyle/EmbeddedProtyleOwner";
import {fetchPost} from "../util/fetch";
import {Dialog} from "../dialog";
import {isMobile} from "../util/functions";
import {escapeAttr, escapeHtml} from "../util/escape";
import {getDisplayName, getNotebookName, isEncryptedBox} from "../util/pathName";
import {getIconByType} from "../protyle/util/getIconByType";
import {unicode2Emoji} from "../emoji";
import {addLoading} from "../protyle/ui/initUI";
import {Constants} from "../constants";
import {onGet} from "../protyle/util/onGet";
import {App} from "../index";
import {confirmDialog} from "../dialog/confirmDialog";
import {OwnerLifecycle} from "../protyle/runtime/ownerLifecycle";

export const viewCards = (app: App, deckID: string, title: string, deckType: "Tree" | "" | "Notebook", cb?: (response: IWebSocketData) => void) => {
    let pageIndex = 1;
    let edit: EmbeddedProtyleOwner;
    const lifecycle = new OwnerLifecycle();
    const ownerGeneration = lifecycle.begin();
    fetchPost(`/api/riff/get${deckType}RiffCards`, {
        id: deckID,
        page: pageIndex
    }, (response) => {
        if (!lifecycle.isCurrent(ownerGeneration, true)) {
            return;
        }
        const dialog = new Dialog({
            positionId: Constants.DIALOG_VIEWCARDS,
            content: `<div class="fn__flex-column" style="height: 100%">
    <div class="block__icons" style="border-bottom: 1px solid var(--b3-border-color)">
        <span class="fn__flex-center resize__move">${escapeHtml(title)}</span>
        <span class="fn__space${(deckType === "" && deckID === "") ? " fn__none" : ""}"></span>
        <span data-type="resetAll" data-position="north" class="block__icon block__icon--show ariaLabel${(deckType === "" && deckID === "") ? " fn__none" : ""}" aria-label="${window.siyuan.languages.reset}"><svg><use xlink:href='#iconUndo'></use></svg></span>
        <span class="fn__space"></span>
        <span data-type="previous" data-position="north" class="block__icon block__icon--show ariaLabel" disabled="disabled" aria-label="${window.siyuan.languages.previousLabel}"><svg><use xlink:href='#iconLeft'></use></svg></span>
        <span class="fn__space"></span>
        <span data-type="next" data-position="north" class="block__icon block__icon--show ariaLabel" disabled="disabled" aria-label="${window.siyuan.languages.nextLabel}"><svg><use xlink:href='#iconRight'></use></svg></span>
        <span class="fn__space"></span>
        <span class="fn__flex-center ft__on-surface">${pageIndex}/${response.data.pageCount || 1}</span>
        <span class="fn__space"></span>
        <span class="counter">${response.data.total}</span>
        ${isMobile() ? `<span class="fn__space"></span>
<div data-type="close" class="block__icon block__icon--show">
    <svg><use xlink:href="#iconCloseRound"></use></svg>
</div>` : ""}
    </div>
    <div class="${isMobile() ? "fn__flex-column" : "fn__flex"} fn__flex-1" style="min-height: auto">
        <ul class="fn__flex-1 b3-list b3-list--background" style="user-select: none;padding: 8px 0">
            ${renderViewItem(response.data.blocks, title, deckType)}
        </ul>
        <div id="cardPreview" style="border-bottom-right-radius:var(--b3-border-radius-b);" class="fn__flex-1 fn__none"></div>
        <div class="fn__flex-1 card__empty">${window.siyuan.languages.emptyContent}</div>
    </div>
</div>`,
            width: isMobile() ? "100vw" : "80vw",
            height: isMobile() ? "100dvh" : "70vh",
            beforeDestroyCallback() {
                lifecycle.destroy();
            },
            destroyCallback() {
                if (edit) {
                    edit.destroy();
                    if (window.siyuan.mobile) {
                        window.siyuan.mobile.popEditor = null;
                    }
                }
            },
            resizeCallback(type: string) {
                if (type !== "d" && type !== "t" && edit) {
                    edit.resize();
                }
            }
        });
        edit = new EmbeddedProtyleOwner(app, dialog.element.querySelector("#cardPreview") as HTMLElement, {
            action: [Constants.CB_GET_ALL],
            render: {
                gutter: true,
                breadcrumbDocName: true,
                title: true,
                hideTitleOnZoom: true,
            },
            typewriterMode: false
        }, window.siyuan.config.readonly);
        dialog.editors = {
            card: edit
        };
        edit.resize();
        const currentElement = dialog.element.querySelector(".b3-list-item--focus");
        getArticle(edit, currentElement?.getAttribute("data-id"), currentElement?.getAttribute("data-notebook-id"), lifecycle);
        const previousElement = dialog.element.querySelector('[data-type="previous"]');
        const nextElement = dialog.element.querySelector('[data-type="next"]');
        const listElement = dialog.element.querySelector(".b3-list--background");
        if (response.data.pageCount > 1) {
            nextElement.removeAttribute("disabled");
        }
        dialog.element.setAttribute("data-key", Constants.DIALOG_VIEWCARDS);
        dialog.element.addEventListener("click", (event) => {
            if (lifecycle.ended || !dialog.element.isConnected) {
                return;
            }
            if (typeof event.detail === "string") {
                let currentElement = listElement.querySelector(".b3-list-item--focus");
                if (currentElement) {
                    currentElement.classList.remove("b3-list-item--focus");
                    if (event.detail === "arrowup") {
                        currentElement = currentElement.previousElementSibling || currentElement.parentElement.lastElementChild;
                    } else if (event.detail === "arrowdown") {
                        currentElement = currentElement.nextElementSibling || currentElement.parentElement.firstElementChild;
                    } else if (event.detail === "home") {
                        currentElement = currentElement.parentElement.firstElementChild;
                    } else if (event.detail === "end") {
                        currentElement = currentElement.parentElement.lastElementChild;
                    }
                    const currentRect = currentElement.getBoundingClientRect();
                    const parentRect = currentElement.parentElement.getBoundingClientRect();
                    if (currentRect.top < parentRect.top || currentRect.bottom > parentRect.bottom) {
                        currentElement.scrollIntoView(currentRect.top < parentRect.top);
                    }
                    getArticle(edit, currentElement.getAttribute("data-id"), currentElement.getAttribute("data-notebook-id"), lifecycle);
                    currentElement.classList.add("b3-list-item--focus");
                }
                event.stopPropagation();
                event.preventDefault();
                return;
            }
            let target = event.target as HTMLElement;
            while (target && (dialog.element !== target)) {
                const type = target.getAttribute("data-type");
                if (type === "close") {
                    dialog.destroy();
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "previous") {
                    if (pageIndex <= 1) {
                        return;
                    }
                    pageIndex--;
                    if (pageIndex <= 1) {
                        previousElement.setAttribute("disabled", "disabled");
                    }
                    const pageGeneration = lifecycle.begin();
                    fetchPost(`/api/riff/get${deckType}RiffCards`, {id: deckID, page: pageIndex}, (cardsResponse) => {
                        if (!lifecycle.isCurrent(pageGeneration, dialog.element.isConnected)) {
                            return;
                        }
                        if (pageIndex === cardsResponse.data.pageCount) {
                            nextElement.setAttribute("disabled", "disabled");
                        } else if (cardsResponse.data.pageCount > 1) {
                            nextElement.removeAttribute("disabled");
                        }
                        nextElement.nextElementSibling.nextElementSibling.textContent = `${pageIndex}/${cardsResponse.data.pageCount || 1}`;
                        listElement.innerHTML = renderViewItem(cardsResponse.data.blocks, title, deckType);
                        listElement.scrollTop = 0;
                        const currentElement = dialog.element.querySelector(".b3-list-item--focus");
                        getArticle(edit, currentElement?.getAttribute("data-id"), currentElement?.getAttribute("data-notebook-id"), lifecycle);
                    }, undefined, undefined, pageGeneration.signal);
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "next") {
                    if (pageIndex >= response.data.pageCount) {
                        return;
                    }
                    pageIndex++;
                    previousElement.removeAttribute("disabled");
                    const pageGeneration = lifecycle.begin();
                    fetchPost(`/api/riff/get${deckType}RiffCards`, {id: deckID, page: pageIndex}, (cardsResponse) => {
                        if (!lifecycle.isCurrent(pageGeneration, dialog.element.isConnected)) {
                            return;
                        }
                        if (pageIndex === cardsResponse.data.pageCount) {
                            nextElement.setAttribute("disabled", "disabled");
                        } else if (cardsResponse.data.pageCount > 1) {
                            nextElement.removeAttribute("disabled");
                        }
                        nextElement.nextElementSibling.nextElementSibling.textContent = `${pageIndex}/${cardsResponse.data.pageCount || 1}`;
                        listElement.innerHTML = renderViewItem(cardsResponse.data.blocks, title, deckType);
                        listElement.scrollTop = 0;
                        const currentElement = dialog.element.querySelector(".b3-list-item--focus");
                        getArticle(edit, currentElement?.getAttribute("data-id"), currentElement?.getAttribute("data-notebook-id"), lifecycle);
                    }, undefined, undefined, pageGeneration.signal);
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "reset") {
                    const resetGeneration = lifecycle.begin();
                    fetchPost("/api/riff/resetRiffCards", {
                        type: deckType === "" ? "deck" : deckType.toLowerCase(),
                        deckID: deckType === "" ? deckID : Constants.QUICK_DECK_ID,
                        id: deckID,
                        blockIDs: [target.getAttribute("data-id")],
                    }, () => {
                        if (!lifecycle.isCurrent(resetGeneration, dialog.element.isConnected)) {
                            return;
                        }
                        target.parentElement.querySelector(".ariaLabel.b3-list-item__meta").textContent = dayjs().format("YYYY-MM-DD");
                    }, undefined, undefined, resetGeneration.signal);
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "resetAll") {
                    confirmDialog(window.siyuan.languages.reset,
                        window.siyuan.languages.resetCardTip.replace("${x}", dialog.element.querySelector(".counter").textContent), () => {
                            if (lifecycle.ended || !dialog.element.isConnected) {
                                return;
                            }
                            const resetGeneration = lifecycle.begin();
                            fetchPost("/api/riff/resetRiffCards", {
                                type: deckType === "" ? "deck" : deckType.toLowerCase(),
                                deckID: deckType === "" ? deckID : Constants.QUICK_DECK_ID,
                                id: deckID,
                            }, () => {
                                if (!lifecycle.isCurrent(resetGeneration, dialog.element.isConnected)) {
                                    return;
                                }
                                dialog.element.querySelectorAll(".ariaLabel.b3-list-item__meta").forEach(item => {
                                    item.textContent = dayjs().format("YYYY-MM-DD");
                                });
                            }, undefined, undefined, resetGeneration.signal);
                        });
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "card-item") {
                    getArticle(edit, target.getAttribute("data-id"), target.getAttribute("data-notebook-id"), lifecycle);
                    listElement.querySelector(".b3-list-item--focus")?.classList.remove("b3-list-item--focus");
                    target.classList.add("b3-list-item--focus");
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "remove") {
                    const removeGeneration = lifecycle.begin();
                    fetchPost("/api/riff/removeRiffCards", {
                        deckID: deckType === "" ? deckID : Constants.QUICK_DECK_ID,
                        blockIDs: [target.getAttribute("data-id")]
                    }, (removeResponse) => {
                        if (!lifecycle.isCurrent(removeGeneration, dialog.element.isConnected)) {
                            return;
                        }
                        let nextElment = target.parentElement.nextElementSibling;
                        if (!nextElment) {
                            nextElment = target.parentElement.previousElementSibling;
                        }
                        if (!nextElment && target.parentElement.parentElement.childElementCount > 1) {
                            nextElment = target.parentElement.parentElement.firstElementChild;
                        }

                        if (!nextElment) {
                            listElement.innerHTML = `<div class="b3-list--empty">${window.siyuan.languages.emptyContent}</div>`;
                        } else {
                            listElement.querySelector(".b3-list-item--focus")?.classList.remove("b3-list-item--focus");
                            nextElment.classList.add("b3-list-item--focus");
                            target.parentElement.remove();
                        }

                        dialog.element.querySelector(".counter").textContent = (parseInt(dialog.element.querySelector(".counter").textContent) - 1).toString();
                        if (cb) {
                            cb(removeResponse);
                        }
                        getArticle(edit, nextElment?.getAttribute("data-id") || "",
                            nextElment?.getAttribute("data-notebook-id"), lifecycle);
                    }, undefined, undefined, removeGeneration.signal);
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                }
                target = target.parentElement;
            }
        });
    }, undefined, undefined, ownerGeneration.signal);
};


const renderViewItem = (blocks: IBlock[], title: string, deckType: string) => {
    let listHTML = "";
    let isFirst = true;
    const pathArray = title.split("/");
    pathArray.splice(0, 1);
    blocks.forEach((item: IBlock) => {
        if (item.type) {
            if (!item.box) {
                throw new Error("[protyle.content] card browser result requires a notebookId");
            }
            let hPath;
            if (deckType === "") {
                hPath = getNotebookName(item.box) + getDisplayName(Lute.UnEscapeHTMLStr(item.hPath), false);
            } else {
                hPath = getDisplayName(Lute.UnEscapeHTMLStr(item.hPath), false).replace("/" + pathArray.join("/"), "");
                if (hPath.startsWith("/")) {
                    hPath = hPath.substring(1);
                }
            }
            listHTML += `<div data-type="card-item" class="b3-list-item${isFirst ? " b3-list-item--focus" : ""}${isMobile() ? "" : " b3-list-item--hide-action"}" data-id="${item.id}" data-notebook-id="${item.box}">
<svg class="b3-list-item__graphic"><use xlink:href="#${getIconByType(item.type)}"></use></svg>
${unicode2Emoji(item.ial.icon, "b3-list-item__graphic", true)}
<span class="b3-list-item__text">${item.content || Constants.ZWSP}</span>
<span class="${(isMobile() || !hPath) ? "fn__none " : ""}b3-list-item__meta b3-list-item__meta--ellipsis" title="${escapeAttr(hPath)}">${escapeHtml(hPath)}</span>
<span data-position="parentE" aria-label="${window.siyuan.languages.revisionCount}" class="ariaLabel counter${item.riffCard?.reps === 0 ? " fn__none" : ""}">${item.riffCard?.reps}</span>
<span data-position="parentE" aria-label="${window.siyuan.languages.nextDue}" class="ariaLabel b3-list-item__meta${!item.riffCard?.due ? " fn__none" : ""}">${dayjs(item.riffCard?.due).format("YYYY-MM-DD")}</span>
<span data-position="parentE" data-type="reset" data-id="${item.id}" class="b3-list-item__action ariaLabel" aria-label="${window.siyuan.languages.reset}">
    <svg><use xlink:href="#iconUndo"></use></svg>
</span>
<span data-position="parentE" data-type="remove" data-id="${item.id}" class="b3-list-item__action b3-list-item__action--warning ariaLabel" aria-label="${window.siyuan.languages.removeDeck}">
    <svg><use xlink:href="#iconTrashcan"></use></svg>
</span>
</div>`;
            isFirst = false;
        } else {
            // 块被删除的情况
            listHTML += `<div data-type="card-item" class="b3-list-item${isMobile() ? "" : " b3-list-item--hide-action"}">
<span class="b3-list-item__text">${item.content}</span>
<span data-position="parentE" data-type="remove" data-id="${item.id}" class="b3-list-item__action b3-list-item__action--warning ariaLabel" aria-label="${window.siyuan.languages.removeDeck}">
    <svg><use xlink:href="#iconTrashcan"></use></svg>
</span>
</div>`;
        }
    });
    if (blocks.length === 0) {
        listHTML = `<div class="b3-list--empty">${window.siyuan.languages.emptyContent}</div>`;
    }
    return listHTML;
};


const getArticle = (edit: EmbeddedProtyleOwner, id: string, notebookId: string | undefined,
                    lifecycle: OwnerLifecycle) => {
    if (lifecycle.ended || edit.signal.aborted || !edit.element.isConnected) {
        return;
    }
    if (!id) {
        lifecycle.begin();
        edit.clear();
        edit.element.classList.add("fn__none");
        edit.element.nextElementSibling.classList.remove("fn__none");
        if (window.siyuan.mobile) {
            window.siyuan.mobile.popEditor = null;
        }
        return;
    }
    if (!notebookId) {
        throw new Error("[protyle.content] card browser target requires a notebookId");
    }
    const ownerGeneration = lifecycle.begin();
    const binding = edit.bind(notebookId, id);
    const protyle = binding.protyle;
    const isCurrent = () => lifecycle.isCurrent(ownerGeneration, edit.element.isConnected) && edit.isCurrent(binding);
    edit.element.classList.remove("fn__none");
    edit.element.nextElementSibling.classList.add("fn__none");
    if (window.siyuan.mobile) {
        window.siyuan.mobile.popEditor = edit.getCurrent();
    }
    protyle.scroll.lastScrollTop = 0;
    addLoading(protyle);
    const docInfoParam: IObject = {id};
    if (isEncryptedBox(notebookId)) {
        docInfoParam.notebook = notebookId;
    }
    fetchPost("/api/block/getDocInfo", docInfoParam, (response) => {
        if (!isCurrent()) {
            return;
        }
        protyle.wysiwyg.renderCustom(response.data.ial);
        const getDocParam: IObject = {
            id,
            mode: 0,
            size: Constants.SIZE_GET_MAX,
        };
        if (isEncryptedBox(notebookId)) {
            getDocParam.notebook = notebookId;
        }
        fetchPost("/api/filetree/getDoc", getDocParam, getResponse => {
            if (!isCurrent()) {
                return;
            }
            onGet({
                updateReadonly: true,
                data: getResponse,
                protyle,
                action: getResponse.data.rootID === getResponse.data.id ? [] : [Constants.CB_GET_ALL],
            });
        }, undefined, undefined, ownerGeneration.signal);
    }, undefined, undefined, ownerGeneration.signal);
};
