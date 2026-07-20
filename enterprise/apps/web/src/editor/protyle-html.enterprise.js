class EnterpriseProtyleHtml extends HTMLElement {
    static observedAttributes = ["data-content"];

    constructor() {
        super();
        this.display = this.attachShadow({mode: "open"});
        this.renderContent();
    }

    attributeChangedCallback(name) {
        if (name === "data-content") {
            this.renderContent();
        }
    }

    // 企业内容只渲染清洗后的 DOM，禁止脚本执行和跨源资源请求。
    renderContent() {
        if (!this.display) {
            return;
        }
        const encodedContent = this.getAttribute("data-content") ?? "";
        const content = Lute.UnEscapeHTMLStr(encodedContent);
        const sanitized = DOMPurify.sanitize(content, {
            FORBID_TAGS: [
                "base",
                "embed",
                "form",
                "iframe",
                "link",
                "meta",
                "object",
                "script",
            ],
        });
        const template = document.createElement("template");
        template.innerHTML = sanitized;
        template.content.querySelectorAll("*").forEach((element) => {
            Array.from(element.attributes).forEach((attribute) => {
                if (!["href", "src", "srcset", "xlink:href"].includes(attribute.name)) {
                    return;
                }
                const value = attribute.value.trim();
                try {
                    const url = new URL(value, window.location.href);
                    if (url.origin !== window.location.origin) {
                        element.removeAttribute(attribute.name);
                    }
                } catch {
                    element.removeAttribute(attribute.name);
                }
            });
        });
        this.display.replaceChildren(template.content.cloneNode(true));
    }
}

customElements.define("protyle-html", EnterpriseProtyleHtml);
