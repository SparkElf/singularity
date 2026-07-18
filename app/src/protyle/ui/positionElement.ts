export const positionElementInViewport = (element: HTMLElement, left: number, top: number) => {
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    const rect = element.getBoundingClientRect();
    const nextLeft = Math.max(0, Math.min(left, document.documentElement.clientWidth - rect.width));
    const nextTop = Math.max(0, Math.min(top, document.documentElement.clientHeight - rect.height));
    element.style.left = `${nextLeft}px`;
    element.style.top = `${nextTop}px`;
};
