export const setToolbarPosition = (
    element: HTMLElement,
    left: number,
    top: number,
    targetHeight = 0,
    targetLeft = 0,
    sticky = false,
) => {
    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
    const rect = element.getBoundingClientRect();
    const viewportTop = 0;
    if (rect.top < viewportTop) {
        element.style.top = `${viewportTop}px`;
    } else if (rect.bottom > window.innerHeight) {
        const above = top - rect.height - targetHeight;
        element.style.top = `${above > viewportTop && above + rect.height < window.innerHeight
            ? above
            : Math.max(viewportTop, window.innerHeight - rect.height)}px`;
    }

    if (sticky) {
        const lockedBottom = element.dataset.positionBottom;
        const lockedX = element.dataset.positionX;
        const sameAnchor = element.dataset.positionTop === String(top);
        if (sameAnchor && lockedBottom !== undefined) {
            const nextTop = top + rect.height <= window.innerHeight
                ? top
                : Math.max(viewportTop, parseFloat(lockedBottom) - rect.height);
            element.style.top = `${nextTop}px`;
        }
        if (sameAnchor && lockedX !== undefined) {
            element.style.left = `${lockedX}px`;
        } else if (rect.right > window.innerWidth) {
            element.style.left = `${window.innerWidth - rect.width - targetLeft}px`;
        } else if (rect.left < 0) {
            element.style.left = "0";
        }
        element.dataset.positionTop = String(top);
        const actualRect = element.getBoundingClientRect();
        element.dataset.positionBottom = String(actualRect.bottom);
        element.dataset.positionX = String(parseFloat(element.style.left));
        return;
    }
    if (rect.right > window.innerWidth) {
        element.style.left = `${window.innerWidth - rect.width - targetLeft}px`;
    } else if (rect.left < 0) {
        element.style.left = "0";
    }
};
