const mergeSearchMarkSibling = (target: Element, sibling: Element, after: boolean) => {
    if (!target.getAttribute("data-type") || !sibling.getAttribute("data-type")) {
        return false;
    }
    target.setAttribute("data-type", target.getAttribute("data-type").replace("search-mark", "").trim());
    sibling.setAttribute("data-type", sibling.getAttribute("data-type").replace("search-mark", "").trim());
    for (const attribute of Array.from(target.attributes)) {
        if (sibling.getAttribute(attribute.name) !== attribute.value) {
            return false;
        }
    }
    target.innerHTML = after
        ? target.innerHTML + sibling.innerHTML
        : sibling.innerHTML + target.innerHTML;
    sibling.remove();
    return true;
};

export const removeSearchMark = (element: HTMLElement) => {
    let previousElement = element.previousSibling as HTMLElement;
    while (previousElement && previousElement.nodeType !== Node.TEXT_NODE &&
    mergeSearchMarkSibling(element, previousElement, false)) {
        previousElement = element.previousSibling as HTMLElement;
    }
    let nextElement = element.nextSibling as HTMLElement;
    while (nextElement && nextElement.nodeType !== Node.TEXT_NODE &&
    mergeSearchMarkSibling(element, nextElement, true)) {
        nextElement = element.nextSibling as HTMLElement;
    }
    if ((element.getAttribute("data-type") || "").includes("search-mark")) {
        element.setAttribute("data-type", element.getAttribute("data-type").replace("search-mark", "").trim());
    }
};
