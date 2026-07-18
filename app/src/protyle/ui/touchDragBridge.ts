import {Constants} from "../../constants";
import {stopScrollAnimation} from "./dragScroll";
import {touchDragOwner} from "./touchDragState";

interface LongPressGate {
    startX: number;
    startY: number;
    touchStartTime: number;
    requireLongPress: boolean;
    longPressCancelled: boolean;
    isMouse: boolean;
}

interface TouchPoint {
    readonly clientX: number;
    readonly clientY: number;
}

interface NativeTouchDragState extends LongPressGate {
    clientX: number;
    clientY: number;
    dataTransfer: DataTransfer | null;
    isDragging: boolean;
    readonly draggableElement: HTMLElement;
    editorElement: HTMLElement | null;
    termination: "active" | "cancel" | "normal";
}

interface ManualTouchDragState extends LongPressGate {
    clientX: number;
    clientY: number;
}

let nativeState: NativeTouchDragState | null = null;
let manualState: ManualTouchDragState | null = null;
let lastDragOverElement: Element | null = null;
let lastPointerType = "";
let installedDisposer: (() => void) | undefined;

const shouldYieldToScroll = (gate: LongPressGate, clientX: number, clientY: number): boolean => {
    const dx = clientX - gate.startX;
    const dy = clientY - gate.startY;
    if (Math.abs(dx) < Constants.SIZE_DRAG_THRESHOLD && Math.abs(dy) < Constants.SIZE_DRAG_THRESHOLD) {
        return true;
    }
    if (gate.isMouse) {
        return gate.requireLongPress &&
            Date.now() - gate.touchStartTime < Constants.TIMEOUT_MOUSE_DRAG_DELAY;
    }
    if (!gate.requireLongPress) {
        return false;
    }
    if (gate.longPressCancelled) {
        return true;
    }
    if (Date.now() - gate.touchStartTime < Constants.TIMEOUT_LONGPRESS) {
        gate.longPressCancelled = true;
        return true;
    }
    return false;
};

const isMouseInput = (touch: Touch): boolean => {
    const hasContactArea = (touch.radiusX ?? 0) > 0 || (touch.radiusY ?? 0) > 0;
    return !hasContactArea && lastPointerType === "mouse";
};

export const isLastPointerMouse = (): boolean => lastPointerType === "mouse";

const getDraggableAncestor = (element: HTMLElement): HTMLElement | null => {
    let current: HTMLElement | null = element;
    while (current) {
        if (current.getAttribute("draggable") === "true") {
            return current;
        }
        if (current === document.body) {
            break;
        }
        current = current.parentElement;
    }
    return null;
};

const getElementUnderTouch = (clientX: number, clientY: number): Element | null => {
    const ghostElement = touchDragOwner.ghost;
    if (ghostElement) {
        ghostElement.style.display = "none";
    }
    const element = document.elementFromPoint(clientX, clientY);
    if (ghostElement) {
        ghostElement.style.display = "";
    }
    return element;
};

const positionGhost = (clientX: number, clientY: number) => {
    const ghostElement = touchDragOwner.ghost;
    if (!ghostElement) {
        return;
    }
    ghostElement.style.left = `${clientX + 12}px`;
    ghostElement.style.top = `${clientY + 12}px`;
};

const clearDragoverClasses = () => {
    document.querySelectorAll(
        ".dragover__top, .dragover__bottom, .dragover__left, .dragover__right, .dragover",
    ).forEach((item) => {
        item.classList.remove("dragover__top", "dragover__bottom", "dragover__left", "dragover__right", "dragover");
    });
};

const dispatchNativeDragEnd = (state: NativeTouchDragState, point: TouchPoint) => {
    state.draggableElement.dispatchEvent(new DragEvent("dragend", {
        bubbles: true,
        cancelable: true,
        clientX: point.clientX,
        clientY: point.clientY,
        dataTransfer: state.dataTransfer,
        view: window,
    }));
};

const cleanupNativeTouch = (state: NativeTouchDragState) => {
    stopScrollAnimation();
    clearDragoverClasses();
    if (nativeState === state) {
        nativeState = null;
        lastDragOverElement = null;
    }
    if (state.isDragging) {
        touchDragOwner.finish();
    }
};

const cancelNativeTouch = (point?: TouchPoint) => {
    const state = nativeState;
    if (!state || state.termination !== "active") {
        return;
    }
    state.termination = "cancel";
    if (state.isDragging) {
        dispatchNativeDragEnd(state, point ?? state);
    }
    cleanupNativeTouch(state);
};

const startNativeTouchDrag = (touch: Touch) => {
    const state = nativeState!;
    state.clientX = touch.clientX;
    state.clientY = touch.clientY;
    state.dataTransfer = new DataTransfer();
    state.isDragging = true;
    state.editorElement = state.draggableElement.closest(".protyle-wysiwyg") as HTMLElement | null;

    touchDragOwner.begin(() => {
        if (nativeState === state && state.termination === "active") {
            cancelNativeTouch();
        }
    });
    state.draggableElement.dispatchEvent(new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        dataTransfer: state.dataTransfer,
        view: window,
    }));
    if (nativeState !== state) {
        return;
    }

    const ghostElement = touchDragOwner.ghost;
    if (ghostElement) {
        ghostElement.style.pointerEvents = "none";
        positionGhost(touch.clientX, touch.clientY);
        ghostElement.style.opacity = "0.6";
    }

    if (state.editorElement) {
        state.editorElement.dispatchEvent(new DragEvent("dragenter", {
            bubbles: false,
            cancelable: true,
            clientX: touch.clientX,
            clientY: touch.clientY,
            dataTransfer: state.dataTransfer,
            view: window,
        }));
    }
};

const continueNativeTouchDrag = (touch: Touch) => {
    const state = nativeState!;
    if (!state.isDragging) {
        return;
    }
    state.clientX = touch.clientX;
    state.clientY = touch.clientY;
    const elementUnderTouch = getElementUnderTouch(touch.clientX, touch.clientY);

    if (elementUnderTouch !== lastDragOverElement) {
        const previousContainer = lastDragOverElement?.parentElement;
        const currentContainer = elementUnderTouch?.parentElement;
        if (previousContainer !== currentContainer) {
            lastDragOverElement?.dispatchEvent(new DragEvent("dragleave", {
                bubbles: true,
                cancelable: true,
                clientX: touch.clientX,
                clientY: touch.clientY,
                dataTransfer: state.dataTransfer,
                view: window,
            }));
            elementUnderTouch?.dispatchEvent(new DragEvent("dragenter", {
                bubbles: true,
                cancelable: true,
                clientX: touch.clientX,
                clientY: touch.clientY,
                dataTransfer: state.dataTransfer,
                view: window,
            }));
        }
        lastDragOverElement = elementUnderTouch;
    }

    elementUnderTouch?.dispatchEvent(new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        dataTransfer: state.dataTransfer,
        view: window,
    }));
    positionGhost(touch.clientX, touch.clientY);
};

const endNativeTouchDrag = (touch: Touch) => {
    const state = nativeState!;
    if (!state.isDragging) {
        state.termination = "normal";
        cleanupNativeTouch(state);
        return;
    }
    state.termination = "normal";
    state.clientX = touch.clientX;
    state.clientY = touch.clientY;
    const elementUnderTouch = getElementUnderTouch(touch.clientX, touch.clientY);
    elementUnderTouch?.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        dataTransfer: state.dataTransfer,
        view: window,
    }));
    dispatchNativeDragEnd(state, touch);
    cleanupNativeTouch(state);
};

const handleTouchStart = (event: TouchEvent) => {
    if (nativeState || manualState || event.touches.length !== 1) {
        return;
    }
    const target = event.target as HTMLElement;

    if (!target.classList.contains("av__widthdrag")) {
        const draggableElement = getDraggableAncestor(target);
        if (draggableElement && !draggableElement.closest(".sy__file")) {
            const touch = event.touches[0];
            nativeState = {
                clientX: touch.clientX,
                clientY: touch.clientY,
                dataTransfer: null,
                draggableElement,
                editorElement: null,
                isDragging: false,
                isMouse: isMouseInput(touch),
                longPressCancelled: false,
                requireLongPress: draggableElement.closest(".sy__outline") !== null ||
                    draggableElement.closest(".av__gallery-item") !== null ||
                    draggableElement.closest(".protyle-action") !== null,
                startX: touch.clientX,
                startY: touch.clientY,
                termination: "active",
                touchStartTime: Date.now(),
            };
            return;
        }
    }

    if (target.tagName === "SELECT" || target.tagName === "OPTION" || target.closest("select")) {
        return;
    }
    if (!target.closest(".dock") &&
        !(target.closest(".b3-dialog") && [
            "resize__move", "resize__rd", "resize__r", "resize__rt", "resize__d",
            "resize__l", "resize__ld", "resize__lt", "resize__t",
        ].some((className) => target.closest(`.${className}`))) &&
        !target.closest(".sy__outline") &&
        !target.closest(".layout__resize") &&
        !target.closest(".layout__resize--lr") &&
        !target.closest(".layout__dockresize") &&
        !target.closest(".layout__dockresize--lr") &&
        !target.closest(".search__drag") &&
        !target.closest(".av__widthdrag") &&
        !target.closest(".av__drag-fill") &&
        !target.closest(".protyle-action__drag") &&
        !target.closest(".table__resize") &&
        !target.closest(".sb__resize") &&
        !target.closest(".protyle-background__img") &&
        !target.closest(".b3-chip")) {
        return;
    }

    const touch = event.touches[0];
    target.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        view: window,
    }));
    manualState = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        isMouse: isMouseInput(touch),
        longPressCancelled: false,
        requireLongPress: target.closest(".sy__outline") !== null,
        startX: touch.clientX,
        startY: touch.clientY,
        touchStartTime: Date.now(),
    };
};

const handleTouchMove = (event: TouchEvent) => {
    if (nativeState) {
        const touch = event.touches[0];
        nativeState.clientX = touch.clientX;
        nativeState.clientY = touch.clientY;
        if (!nativeState.isDragging) {
            if (shouldYieldToScroll(nativeState, touch.clientX, touch.clientY)) {
                return;
            }
            event.preventDefault();
            startNativeTouchDrag(touch);
            return;
        }
        event.preventDefault();
        continueNativeTouchDrag(touch);
        return;
    }

    if (!manualState || typeof document.onmousemove !== "function") {
        return;
    }
    const touch = event.touches[0];
    manualState.clientX = touch.clientX;
    manualState.clientY = touch.clientY;
    if (shouldYieldToScroll(manualState, touch.clientX, touch.clientY)) {
        return;
    }

    event.preventDefault();
    if (!touchDragOwner.active) {
        touchDragOwner.begin(cancelManualTouch);
    }
    document.elementFromPoint(touch.clientX, touch.clientY)?.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
    }));
};

export const cancelManualTouch = () => {
    const state = manualState;
    if (!state) {
        return;
    }
    manualState = null;
    document.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        clientX: state.clientX,
        clientY: state.clientY,
        view: window,
    }));
    touchDragOwner.finish();
};

const handleTouchEnd = (event: TouchEvent) => {
    if (nativeState) {
        if (nativeState.isDragging) {
            event.preventDefault();
        }
        endNativeTouchDrag(event.changedTouches[0]);
        return;
    }
    cancelManualTouch();
};

const handleTouchCancel = (event: TouchEvent) => {
    if (nativeState) {
        cancelNativeTouch(event.changedTouches[0]);
        return;
    }
    cancelManualTouch();
};

const handlePointerDown = (event: PointerEvent) => {
    lastPointerType = event.pointerType;
};

/** 取消当前桥接手势但保留页面级监听，供 BFCache 冻结等非终止生命周期使用。 */
export const cancelTouchDragBridgeGesture = () => {
    if (nativeState) {
        cancelNativeTouch();
    } else {
        cancelManualTouch();
    }
    stopScrollAnimation();
};

/** 安装浏览器触控拖拽桥接；返回值可重复调用且会移除本模块注册的全部监听。 */
export const installTouchDragBridge = (): (() => void) => {
    if (installedDisposer) {
        return installedDisposer;
    }

    document.addEventListener("pointerdown", handlePointerDown, {passive: true});
    document.addEventListener("touchstart", handleTouchStart, {passive: false});
    document.addEventListener("touchmove", handleTouchMove, {passive: false});
    document.addEventListener("touchend", handleTouchEnd);
    document.addEventListener("touchcancel", handleTouchCancel);

    let disposed = false;
    installedDisposer = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        document.removeEventListener("pointerdown", handlePointerDown);
        document.removeEventListener("touchstart", handleTouchStart);
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
        document.removeEventListener("touchcancel", handleTouchCancel);
        cancelTouchDragBridgeGesture();
        lastPointerType = "";
        installedDisposer = undefined;
    };
    return installedDisposer;
};
