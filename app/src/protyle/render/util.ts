export const processClonePHElement = (item: Element) => {
    item.querySelectorAll("protyle-html").forEach((phElement) => {
        phElement.setAttribute("data-content", Lute.UnEscapeHTMLStr(phElement.getAttribute("data-content")));
    });
    return item;
};
