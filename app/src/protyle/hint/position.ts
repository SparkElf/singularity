export const setHintPosition = (
    element: HTMLElement,
    left: number,
    top: number,
    targetHeight = 0,
    targetLeft = 0,
) => {
    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
    const rect = element.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight;
    const viewportWidth = document.documentElement.clientWidth;
    if (rect.top < 0) {
        element.style.top = "0";
    } else if (rect.bottom > viewportHeight) {
        const above = top - rect.height - targetHeight;
        element.style.top = `${above >= 0 ? above : Math.max(0, viewportHeight - rect.height)}px`;
    }
    const positioned = element.getBoundingClientRect();
    if (positioned.right > viewportWidth) {
        element.style.left = `${Math.max(0, viewportWidth - positioned.width - targetLeft)}px`;
    } else if (positioned.left < 0) {
        element.style.left = "0";
    }
};
