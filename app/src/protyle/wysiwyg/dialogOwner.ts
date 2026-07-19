import type {ProtyleOverlayHandle} from "../../../../enterprise/packages/protyle-browser/src/contracts";

export interface OpenProtyleDialogOptions {
    readonly protyle: IProtyle;
    readonly title: string;
    readonly width?: string;
    readonly onClose?: () => void;
}

export interface ProtyleDialogOwner {
    readonly bodyElement: HTMLElement;
    readonly element: HTMLElement;
    readonly signal: AbortSignal;
    close(): void;
}

export interface OpenProtyleConfirmOptions {
    readonly destructive?: boolean;
    readonly message: string;
    readonly onConfirm: () => void;
    readonly protyle: IProtyle;
    readonly title: string;
}

export const openProtyleDialog = (options: OpenProtyleDialogOptions): ProtyleDialogOwner => {
    const controller = new AbortController();
    const element = document.createElement("div");
    element.className = "b3-dialog b3-dialog--open";
    element.dataset.protyleDialog = "";
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-modal", "true");
    element.setAttribute("aria-label", options.title);

    const scrim = document.createElement("div");
    scrim.className = "b3-dialog__scrim";
    const container = document.createElement("div");
    container.className = "b3-dialog__container";
    container.style.width = options.width ?? "min(520px, calc(100vw - 32px))";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "b3-dialog__close";
    closeButton.setAttribute("aria-label", options.protyle.localization.text("close"));
    closeButton.style.background = "transparent";
    closeButton.style.border = "0";
    closeButton.innerHTML = '<svg><use href="#iconCloseRound"></use></svg>';
    const header = document.createElement("div");
    header.className = "b3-dialog__header";
    header.textContent = options.title;
    const bodyElement = document.createElement("div");
    bodyElement.className = "b3-dialog__body";
    container.append(closeButton, header, bodyElement);
    element.append(scrim, container);

    const overlays = (options.protyle.session!.runtime as TProtyleRuntime).overlays;
    let overlayHandle!: ProtyleOverlayHandle;
    let closed = false;
    const close = () => {
        if (closed) {
            return;
        }
        closed = true;
        controller.abort();
        options.protyle.requestSignal.removeEventListener("abort", close);
        try {
            options.onClose?.();
        } finally {
            overlayHandle.close();
        }
    };
    overlayHandle = overlays.add(element, close);
    try {
        options.protyle.element.append(element);
        overlays.bringToFront(element);
    } catch (error) {
        close();
        throw error;
    }
    scrim.addEventListener("click", close, {signal: controller.signal});
    closeButton.addEventListener("click", close, {signal: controller.signal});
    element.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !event.repeat) {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    }, {signal: controller.signal});
    options.protyle.requestSignal.addEventListener("abort", close, {once: true});
    if (options.protyle.requestSignal.aborted) {
        close();
    }

    return {
        bodyElement,
        element,
        signal: controller.signal,
        close,
    };
};

export const openProtyleConfirm = (options: OpenProtyleConfirmOptions): ProtyleDialogOwner => {
    const owner = openProtyleDialog({
        protyle: options.protyle,
        title: options.title,
    });
    const content = document.createElement("div");
    content.className = "b3-dialog__content ft__breakword";
    content.textContent = options.message;
    const actions = document.createElement("div");
    actions.className = "b3-dialog__action";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "b3-button b3-button--cancel";
    cancel.textContent = options.protyle.localization.text("cancel");
    const spacer = document.createElement("div");
    spacer.className = "fn__space";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = `b3-button ${options.destructive ? "b3-button--remove" : "b3-button--text"}`;
    confirm.textContent = options.protyle.localization.text(options.destructive ? "delete" : "confirm");
    actions.append(cancel, spacer, confirm);
    owner.bodyElement.append(content, actions);

    const accept = () => {
        try {
            options.onConfirm();
        } finally {
            owner.close();
        }
    };
    cancel.addEventListener("click", owner.close, {signal: owner.signal});
    confirm.addEventListener("click", accept, {signal: owner.signal});
    owner.element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.repeat) {
            event.preventDefault();
            event.stopPropagation();
            accept();
        }
    }, {signal: owner.signal});
    confirm.focus();
    return owner;
};
