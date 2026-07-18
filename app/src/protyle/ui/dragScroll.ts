import {Constants} from "../../constants";

const dragScrollState: {
    animationId: number | undefined,
    element: Element | undefined,
    space: number | undefined,
    lastTime: number | undefined,
} = {
    animationId: undefined,
    element: undefined,
    space: undefined,
    lastTime: undefined,
};

export const stopScrollAnimation = () => {
    if (dragScrollState.animationId === undefined) {
        return;
    }
    cancelAnimationFrame(dragScrollState.animationId);
    dragScrollState.animationId = undefined;
    dragScrollState.element = undefined;
    dragScrollState.space = undefined;
    dragScrollState.lastTime = undefined;
};

const scrollAnimation = (timestamp: number) => {
    if (dragScrollState.lastTime === undefined) {
        dragScrollState.lastTime = timestamp - 8;
    }
    dragScrollState.element!.scroll({
        top: dragScrollState.element!.scrollTop +
            (timestamp - dragScrollState.lastTime) * dragScrollState.space! / 64,
    });
    dragScrollState.animationId = requestAnimationFrame(scrollAnimation);
    dragScrollState.lastTime = timestamp;
};

export const dragOverScroll = (moveEvent: Pick<MouseEvent, "clientY">, contentRect: DOMRect, element: Element) => {
    const dragToUp = moveEvent.clientY < contentRect.top + Constants.SIZE_SCROLL_TB;
    if (!dragToUp && moveEvent.clientY <= contentRect.bottom - Constants.SIZE_SCROLL_TB) {
        stopScrollAnimation();
        return;
    }

    const space = dragToUp ?
        moveEvent.clientY - contentRect.top - Constants.SIZE_SCROLL_TB :
        moveEvent.clientY - contentRect.bottom + Constants.SIZE_SCROLL_TB;
    if (dragScrollState.animationId !== undefined && dragScrollState.element !== element) {
        stopScrollAnimation();
    }
    dragScrollState.space = space;
    if (dragScrollState.animationId === undefined) {
        dragScrollState.element = element;
        dragScrollState.animationId = requestAnimationFrame(scrollAnimation);
    }
};
