import {hideElements} from "../ui/hideElements";
import {resize} from "./resize";

const refreshWorkspaceOutline = (protyle: IProtyle) => {
    if (protyle.surface === "workspace") {
        protyle.host.dispatch({
            type: "refresh-outline",
            notebookId: protyle.notebookId,
            documentId: protyle.block.rootID,
        });
    }
};

export const setEditMode = (protyle: IProtyle, type: TEditorMode) => {
    if (type === "preview") {
        if (!protyle.preview.element.classList.contains("fn__none")) {
            return;
        }
        protyle.preview.element.classList.remove("fn__none");
        protyle.contentElement.classList.add("fn__none");
        protyle.scroll?.element.classList.add("fn__none");
        if (protyle.options.render.breadcrumb) {
            protyle.breadcrumb?.element.classList.add("fn__none");
            protyle.breadcrumb.toggleExit(true);
        }
        protyle.preview.render(protyle);
        refreshWorkspaceOutline(protyle);
    } else if (type === "wysiwyg") {
        if (!protyle.contentElement.classList.contains("fn__none")) {
            return;
        }
        protyle.preview.element.classList.add("fn__none");
        protyle.contentElement.classList.remove("fn__none");
        if (protyle.options.render.scroll) {
            protyle.scroll?.element.classList.remove("fn__none");
        }
        if (protyle.options.render.breadcrumb) {
            protyle.breadcrumb?.element.classList.remove("fn__none");
            protyle.breadcrumb.toggleExit(!protyle.block.showAll);
        }
        refreshWorkspaceOutline(protyle);
        resize(protyle);
    }
    hideElements(["gutterOnly", "toolbar", "select", "hint", "util"], protyle);
    protyle.plugins.emit({type: "switch-protyle-mode", detail: {protyle}});
};
