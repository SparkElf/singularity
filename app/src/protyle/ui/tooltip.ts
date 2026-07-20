import type {ProtyleOverlayHandle} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {isNarrowViewport} from "../util/browserPlatform";

interface ProtyleTooltipRegistration {
    readonly element: HTMLElement;
    readonly handle: ProtyleOverlayHandle;
}

const registrations = new WeakMap<IProtyle, ProtyleTooltipRegistration>();

const createTooltip = (protyle: IProtyle): ProtyleTooltipRegistration => {
    const element = document.createElement("div");
    element.className = "tooltip fn__none";
    element.dataset.protyleTooltip = "";
    element.setAttribute("role", "tooltip");
    protyle.element.append(element);
    const overlays = protyle.runtime.overlays;
    const registration = {
        element,
        handle: overlays.add(element),
    };
    registrations.set(protyle, registration);
    return registration;
};

const getTargetRect = (target: Element, event?: MouseEvent): DOMRect => {
    let targetRect = target.getBoundingClientRect();
    const clientRects = Array.from(target.getClientRects());
    if (clientRects.length <= 1) {
        return targetRect;
    }
    if (event) {
        clientRects.forEach((rect) => {
            if (event.clientY >= rect.top - 3 && event.clientY <= rect.bottom) {
                targetRect = rect;
            }
        });
        return targetRect;
    }
    return clientRects.reduce((widest, rect) => rect.width > widest.width ? rect : widest);
};

export const hideTooltip = (protyle: IProtyle) => {
    registrations.get(protyle)?.element.classList.add("fn__none");
};

export const disposeTooltip = (protyle: IProtyle) => {
    const registration = registrations.get(protyle);
    if (!registration) {
        return;
    }
    registrations.delete(protyle);
    registration.handle.close();
};

export const showTooltip = (
    protyle: IProtyle,
    message: string | null,
    target: Element,
    tooltipClass?: string,
    event?: MouseEvent,
    space = 0.5,
) => {
    if (protyle.content.mode === "local-only" || isNarrowViewport() || !message) {
        return;
    }
    const registration = registrations.get(protyle) ?? createTooltip(protyle);
    const messageElement = registration.element;
    const targetRect = getTargetRect(target, event);
    if (targetRect.height === 0) {
        hideTooltip(protyle);
        return;
    }

    messageElement.className = tooltipClass ? `tooltip tooltip--${tooltipClass}` : "tooltip";
    messageElement.textContent = message;
    messageElement.removeAttribute("style");
    protyle.runtime.overlays.bringToFront(messageElement);

    const position = target.getAttribute("data-position");
    const parentRect = target.parentElement!.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    let left: number;
    let top: number;

    if (position === "parentE") {
        top = Math.max(0, parentRect.top - (messageElement.clientHeight - parentRect.height) / 2);
        top = Math.min(top, viewportHeight - messageElement.clientHeight);
        left = parentRect.right + 8;
        if (left + messageElement.clientWidth > viewportWidth) {
            left = parentRect.left - messageElement.clientWidth - 8;
        }
    } else if (position === "parentW") {
        top = Math.max(0, parentRect.top - (messageElement.clientHeight - parentRect.height) / 2);
        top = Math.min(top, viewportHeight - messageElement.clientHeight);
        left = parentRect.left - messageElement.clientWidth;
        if (left < 0) {
            left = parentRect.right;
        }
    } else if (position?.endsWith("west")) {
        const positionDiff = Number.parseInt(position, 10) || space;
        top = Math.max(0, targetRect.top - (messageElement.clientHeight - targetRect.height) / 2);
        top = Math.min(top, viewportHeight - messageElement.clientHeight);
        left = targetRect.left - messageElement.clientWidth - positionDiff;
        if (left < 0) {
            left = targetRect.right;
        }
    } else if (position?.endsWith("east")) {
        const positionDiff = Number.parseInt(position, 10) || space;
        top = Math.max(0, targetRect.top - (messageElement.clientHeight - targetRect.height) / 2);
        top = Math.min(top, viewportHeight - messageElement.clientHeight);
        left = targetRect.right + positionDiff;
        if (left + messageElement.clientWidth > viewportWidth) {
            left = targetRect.left - messageElement.clientWidth - positionDiff;
        }
    } else if (position?.endsWith("north")) {
        const positionDiff = Number.parseInt(position, 10) || space;
        left = Math.max(0, targetRect.left - (messageElement.clientWidth - targetRect.width) / 2);
        top = targetRect.top - messageElement.clientHeight - positionDiff;
        if (top < 0) {
            if (targetRect.top < viewportHeight - targetRect.bottom) {
                top = targetRect.bottom + positionDiff;
                messageElement.style.maxHeight = `${viewportHeight - top}px`;
            } else {
                top = 0;
                messageElement.style.maxHeight = `${targetRect.top - positionDiff}px`;
            }
        }
        if (left + messageElement.clientWidth > viewportWidth) {
            left = viewportWidth - messageElement.clientWidth;
        }
    } else {
        const positionDiff = Number.parseInt(position ?? "", 10) || space;
        left = Math.max(0, targetRect.left - (messageElement.clientWidth - targetRect.width) / 2);
        top = targetRect.bottom + positionDiff;
        if (top + messageElement.clientHeight > viewportHeight) {
            if (targetRect.top - positionDiff > viewportHeight - top) {
                top = Math.max(0, targetRect.top - positionDiff - messageElement.clientHeight);
                messageElement.style.maxHeight = `${targetRect.top - positionDiff}px`;
            } else {
                messageElement.style.maxHeight = `${viewportHeight - top}px`;
            }
        }
        if (left + messageElement.clientWidth > viewportWidth) {
            left = viewportWidth - messageElement.clientWidth;
        }
    }
    messageElement.style.top = `${top}px`;
    messageElement.style.left = `${Math.max(0, left)}px`;
    const tooltipDelay = target.getAttribute("data-delay");
    if (tooltipDelay) {
        messageElement.style.animationDelay = `${tooltipDelay}ms`;
    }
};
