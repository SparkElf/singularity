import {isNarrowViewport} from "../util/browserPlatform";
import {hasClosestBlock} from "../util/hasClosest";
import {updateTransaction} from "../wysiwyg/transaction";
import {mathRender} from "../render/mathRender";
import {HintMenuOwner, type OwnedHintMenu} from "./menuOwner";

const showMenu = (owned: OwnedHintMenu, position: IPosition) => {
    if (isNarrowViewport()) {
        owned.menu.fullscreen();
    } else {
        owned.menu.popup(position);
    }
};

export const openImageHintMenu = (
    protyle: IProtyle,
    owner: HintMenuOwner,
    assetElement: HTMLElement,
    position: IPosition,
) => {
    const nodeElement = hasClosestBlock(assetElement);
    if (!nodeElement) {
        return;
    }
    const image = assetElement.querySelector<HTMLImageElement>("img")!;
    const title = assetElement.querySelector<HTMLElement>(".protyle-action__title span")!;
    const previousHTML = nodeElement.outerHTML;
    const owned = owner.open(() => {
        if (nodeElement.isConnected && nodeElement.outerHTML !== previousHTML) {
            updateTransaction(protyle, nodeElement, previousHTML);
        }
    });
    owned.menu.addItem({
        iconHTML: "",
        type: "empty",
        label: `<label>${protyle.localization.text("imageURL")}</label><textarea data-field="url" spellcheck="false" style="margin:4px 0;width:${isNarrowViewport() ? "100%" : "360px"}" rows="1" class="b3-text-field"></textarea>
<div class="fn__hr"></div><label>${protyle.localization.text("title")}</label><textarea data-field="title" style="margin:4px 0;width:${isNarrowViewport() ? "100%" : "360px"}" rows="1" class="b3-text-field"></textarea>
<div class="fn__hr"></div><label>${protyle.localization.text("tooltipText")}</label><textarea data-field="tooltip" style="margin:4px 0;width:${isNarrowViewport() ? "100%" : "360px"}" rows="1" class="b3-text-field"></textarea>`,
        bind: (element) => {
            element.style.maxWidth = "none";
            const url = element.querySelector<HTMLTextAreaElement>('[data-field="url"]')!;
            const titleInput = element.querySelector<HTMLTextAreaElement>('[data-field="title"]')!;
            const tooltip = element.querySelector<HTMLTextAreaElement>('[data-field="tooltip"]')!;
            url.value = image.getAttribute("data-src") ?? image.getAttribute("src") ?? "";
            titleInput.value = title.innerText;
            tooltip.value = image.alt;
            url.addEventListener("input", () => {
                const value = url.value.replace(/\r\n|\r|\n|\u2028|\u2029/g, "").trim();
                image.setAttribute("src", value);
                image.dataset.src = value;
                const marker = assetElement.querySelector(".img__net");
                if ((value.startsWith("assets/") || value.startsWith("data:image/")) && marker) {
                    marker.remove();
                } else if (!value.startsWith("assets/") && !value.startsWith("data:image/") &&
                    protyle.settings.editor.displayNetImgMark && !marker) {
                    assetElement.querySelector(".protyle-action__drag")!.insertAdjacentHTML(
                        "afterend",
                        '<span class="img__net"><svg><use xlink:href="#iconGlobe"></use></svg></span>',
                    );
                }
            });
            titleInput.addEventListener("input", () => {
                image.title = titleInput.value;
                title.innerText = titleInput.value;
                mathRender(title, protyle);
            });
            tooltip.addEventListener("input", () => {
                image.alt = tooltip.value;
            });
            url.focus();
        },
    });
    showMenu(owned, position);
};
