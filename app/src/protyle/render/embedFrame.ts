import {Constants} from "../../constants";
import {isInEmbedBlock} from "../util/hasClosest";

export interface EmbedFrameLabels {
    readonly more: string;
    readonly refPopover: string;
    readonly refresh: string;
    readonly update: string;
}

export const genEmbedRenderFrame = (renderElement: Element, labels: EmbedFrameLabels) => {
    let iconsElement = renderElement.querySelector(":scope > .protyle-icons");
    if (!iconsElement) {
        renderElement.insertAdjacentHTML("afterbegin", `<div class="protyle-icons${isInEmbedBlock(renderElement) ? " fn__none" : ""}">
    <span aria-label="${labels.refresh}" data-position="4north" class="ariaLabel protyle-icon protyle-action__reload protyle-icon--first"><svg class="fn__rotate"><use xlink:href="#iconRefresh"></use></svg></span>
    <span aria-label="${labels.update} SQL" data-position="4north" class="ariaLabel protyle-icon protyle-action__edit"><svg><use xlink:href="#iconEdit"></use></svg></span>
    <span aria-label="${labels.refPopover}" data-position="4north" data-action="openFloat" class="ariaLabel protyle-icon"><svg><use xlink:href="#iconPictureInPicture"></use></svg></span>
    <span aria-label="${labels.more}" data-position="4north" class="ariaLabel protyle-icon protyle-action__menu protyle-icon--last"><svg><use xlink:href="#iconMore"></use></svg></span>
</div>`);
        iconsElement = renderElement.firstElementChild!;
    }
    if (!renderElement.querySelector(":scope > .protyle-cursor")) {
        iconsElement.insertAdjacentHTML("afterend", `<div class="protyle-cursor">${Constants.ZWSP}</div>`);
    }
};
