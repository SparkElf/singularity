import {isMobile} from "../util/functions";
import {Dialog} from "./index";
import {Constants} from "../constants";
import {ConfirmDialogLifecycle} from "./confirmDialogLifecycle";

export const confirmDialog = (title: string, text: string,
                              confirm?: (dialog?: Dialog) => void,
                              cancel?: (dialog: Dialog) => void,
                              isDelete = false,
                              signal?: AbortSignal) => {
    if (!text && !title) {
        if (!signal?.aborted) {
            confirm();
        }
        return;
    }
    const lifecycle = new ConfirmDialogLifecycle(confirm, cancel);
    const dialog = new Dialog({
        title,
        content: `<div class="b3-dialog__content">
    <div class="ft__breakword">${text}</div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel" id="cancelDialogConfirmBtn">${window.siyuan.languages.cancel}</button><div class="fn__space"></div>
    <button class="b3-button ${isDelete ? "b3-button--remove" : "b3-button--text"}" id="confirmDialogConfirmBtn">${window.siyuan.languages[isDelete ? "delete" : "confirm"]}</button>
</div>`,
        width: isMobile() ? "92vw" : "520px",
        beforeDestroyCallback() {
            signal?.removeEventListener("abort", abort);
            lifecycle.cancel(dialog);
        },
    });
    const abort = () => dialog.destroy();

    dialog.element.addEventListener("click", (event) => {
        let target = event.target as HTMLElement;
        const isDispatch = typeof event.detail === "string";
        while (target && target !== dialog.element || isDispatch) {
            if (target.id === "cancelDialogConfirmBtn" || (isDispatch && event.detail=== "Escape")) {
                try {
                    lifecycle.cancel(dialog);
                } finally {
                    dialog.destroy();
                }
                break;
            } else if (target.id === "confirmDialogConfirmBtn" || (isDispatch && event.detail=== "Enter")) {
                try {
                    lifecycle.confirm(dialog);
                } finally {
                    dialog.destroy();
                }
                break;
            }
            target = target.parentElement;
        }
    });
    dialog.element.setAttribute("data-key", Constants.DIALOG_CONFIRM);
    if (signal?.aborted) {
        abort();
    } else {
        signal?.addEventListener("abort", abort, {once: true});
    }
    return dialog;
};
