import {Dialog} from "../dialog";
import {isMobile} from "../util/functions";
import {fetchSyncPost} from "../util/fetch";
import {Constants} from "../constants";
import type {ProtyleMenuSurface} from "../../../enterprise/packages/protyle-browser/src/contracts";

export const openBlockRefTransfer = (
    id: string,
    submit: (targetId: string) => Promise<void>,
) => {
    const renameDialog = new Dialog({
        title: window.siyuan.languages.transferBlockRef,
        content: `<div class="b3-dialog__content">
    <input class="b3-text-field fn__block" placeholder="${window.siyuan.languages.targetBlockID}">
    <div class="b3-label__text">${window.siyuan.languages.transferBlockRefTip}</div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${window.siyuan.languages.cancel}</button><div class="fn__space"></div>
    <button class="b3-button b3-button--text">${window.siyuan.languages.confirm}</button>
</div>`,
        width: isMobile() ? "92vw" : "520px",
    });
    renameDialog.element.setAttribute("data-key", Constants.DIALOG_TRANSFERBLOCKREF);
    const inputElement = renameDialog.element.querySelector("input") as HTMLInputElement;
    const btnsElement = renameDialog.element.querySelectorAll(".b3-button");
    renameDialog.bindInput(inputElement, () => {
        (btnsElement[1] as HTMLButtonElement).click();
    });
    inputElement.focus();
    btnsElement[0].addEventListener("click", () => {
        renameDialog.destroy();
    });
    btnsElement[1].addEventListener("click", () => {
        const submitButton = btnsElement[1] as HTMLButtonElement;
        submitButton.disabled = true;
        void submit(inputElement.value).then(() => {
            renameDialog.destroy();
        }).catch((error) => {
            console.error("[protyle-host:transfer-block-ref] request failed", error);
            submitButton.disabled = false;
        });
    });
};

export const transferBlockRef = (menu: ProtyleMenuSurface, id: string) => {
    menu.addItem({
        id: "transferBlockRef",
        label: window.siyuan.languages.transferBlockRef,
        icon: "iconScrollHoriz",
        click: () => openBlockRefTransfer(id, async (targetId) => {
            await fetchSyncPost("/api/block/transferBlockRef", {
                fromID: id,
                toID: targetId,
            });
        }),
    });
};
