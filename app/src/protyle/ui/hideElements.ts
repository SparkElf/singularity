import {isIPhone} from "../util/browserPlatform";

type TProtyleElement = "gutter" | "toolbar" | "select" | "hint" | "util" | "gutterOnly";
type TGlobalElement = "toolbar" | "pdfutil" | "gutter";

const hideToolbarUtil = (protyle: IProtyle, focusHide = false) => {
    if (!protyle.toolbar) {
        return;
    }
    const pinElement = protyle.toolbar.subElement.querySelector('[data-type="pin"]');
    if (!protyle.toolbar.isMultiSelectMode() &&
        (focusHide || !pinElement || pinElement.getAttribute("aria-label") === protyle.localization.text("pin"))) {
        protyle.toolbar.subElement.classList.add("fn__none");
        if (protyle.toolbar.subElementCloseCB) {
            protyle.toolbar.subElementCloseCB();
            protyle.toolbar.subElementCloseCB = undefined;
        }
    }
};

// "gutter", "toolbar", "select", "hint", "util", "gutterOnly"
export const hideElements = (panels: TProtyleElement[], protyle: IProtyle, focusHide = false) => {
    if (panels.includes("hint")) {
        clearTimeout(protyle.hint.timeId);
        protyle.hint.element.classList.add("fn__none");
    }
    if (protyle.gutter && panels.includes("gutter")) {
        protyle.gutter.element.classList.add("fn__none");
        protyle.gutter.element.innerHTML = "";
        // https://ld246.com/article/1651935412480
        protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--hl").forEach((item) => {
            item.classList.remove("protyle-wysiwyg--hl");
        });
    }
    //  不能 remove("protyle-wysiwyg--hl") 否则打开页签的时候 "cb-get-hl" 高亮会被移除
    if (protyle.gutter && panels.includes("gutterOnly")) {
        if (!isIPhone()) {
            protyle.gutter.element.classList.add("fn__none");
        }
        protyle.gutter.element.innerHTML = "";
    }
    if (protyle.toolbar && panels.includes("toolbar")) {
        protyle.toolbar.element.classList.add("fn__none");
        protyle.toolbar.element.style.display = "";
    }
    if (panels.includes("util")) {
        hideToolbarUtil(protyle, focusHide);
    }
    if (panels.includes("select")) {
        protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--select").forEach(item => {
            item.classList.remove("protyle-wysiwyg--select");
            item.removeAttribute("select-start");
            item.removeAttribute("select-end");
        });
    }
};

export const hideAllEditorElements = (editors: TProtyleEditorRegistry) => {
    editors.forEach((editor) => hideToolbarUtil(editor));
};

// "toolbar", "pdfutil", "gutter"
export const hideAllElements = (types: TGlobalElement[]) => {
    if (types.includes("toolbar")) {
        document.querySelectorAll(".protyle-toolbar").forEach((item: HTMLElement) => {
            item.classList.add("fn__none");
            item.style.display = "";
        });
    }
    if (types.includes("pdfutil")) {
        document.querySelectorAll(".pdf__util").forEach(item => {
            item.classList.add("fn__none");
        });
    }
    if (types.includes("gutter")) {
        document.querySelectorAll(".protyle-gutters").forEach(item => {
            item.classList.add("fn__none");
            item.innerHTML = "";
        });
    }
};
