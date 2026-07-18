const SIYUAN_HTML_PATTERN = /<!--data-siyuan='([^']+)'-->/;
const SIYUAN_HTML_GLOBAL_PATTERN = /<!--data-siyuan='[^']+'-->/g;

export interface BrowserClipboardData extends IClipboardData {
    textHTML: string;
    textPlain: string;
    siyuanHTML: string;
}

export const encodeBase64 = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
};

export const getTextSiyuanFromTextHTML = (html: string) => {
    if (html.trimStart().startsWith("<html") &&
        html.substring(0, html.indexOf(">")).includes('xmlns:x="urn:schemas-microsoft-com:office:excel"')) {
        return {
            textSiyuan: "",
            textHtml: html.replace(SIYUAN_HTML_GLOBAL_PATTERN, ""),
        };
    }

    const match = html.match(SIYUAN_HTML_PATTERN);
    if (!match) {
        return {textSiyuan: "", textHtml: html};
    }
    try {
        const bytes = Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0));
        return {
            textSiyuan: new TextDecoder().decode(bytes),
            textHtml: html.replace(SIYUAN_HTML_GLOBAL_PATTERN, ""),
        };
    } catch (error) {
        console.warn("[protyle.clipboard] invalid data-siyuan payload", error);
        return {textSiyuan: "", textHtml: html};
    }
};

const browserClipboard = () => {
    if (!navigator.clipboard) {
        throw new Error("[protyle.clipboard] Clipboard API is unavailable");
    }
    return navigator.clipboard;
};

export const readText = async () => browserClipboard().readText();

export const readClipboard = async (): Promise<BrowserClipboardData> => {
    const clipboard = browserClipboard();
    if (typeof clipboard.read !== "function") {
        throw new Error("[protyle.clipboard] Clipboard item reads are unavailable");
    }

    const value: BrowserClipboardData = {textPlain: "", textHTML: "", siyuanHTML: ""};
    const items = await clipboard.read();
    for (const item of items) {
        if (item.types.includes("text/html")) {
            const html = await (await item.getType("text/html")).text();
            const parsed = getTextSiyuanFromTextHTML(html);
            value.textHTML = parsed.textHtml;
            value.siyuanHTML = parsed.textSiyuan;
        }
        if (item.types.includes("text/plain")) {
            value.textPlain = await (await item.getType("text/plain")).text();
        }
        if (item.types.includes("image/png")) {
            const image = await item.getType("image/png");
            value.files = [new File([image], "image.png", {
                type: "image/png",
                lastModified: Date.now(),
            })];
        }
    }
    return value;
};

export const writeText = async (text: string) => browserClipboard().writeText(text);

export const plainTextForClipboard = (text: string) => text.replace(/\u200b/g, "");

export const copyPlainText = async (text: string) => writeText(plainTextForClipboard(text));
