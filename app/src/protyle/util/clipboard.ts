import type {ProtyleContentIdentity} from "../../../../enterprise/packages/protyle-browser/src/contracts";

const SIYUAN_HTML_PATTERN = /<!--data-siyuan='([^']+)'-->/;
const SIYUAN_HTML_GLOBAL_PATTERN = /<!--data-siyuan='[^']+'-->/g;
const SIYUAN_CLIPBOARD_VERSION = 1;

export interface ProtyleClipboardSourceIdentity extends ProtyleContentIdentity {
    readonly spaceId: string;
}

export interface ProtyleClipboardData {
    files?: File[];
    localFiles?: ILocalFiles[];
    siyuanHTML?: string;
    sourceIdentity?: ProtyleClipboardSourceIdentity;
    textHTML?: string;
    textPlain?: string;
}

export interface BrowserClipboardData extends ProtyleClipboardData {
    textHTML: string;
    textPlain: string;
    siyuanHTML: string;
}

interface SiyuanClipboardPayload {
    readonly source: ProtyleClipboardSourceIdentity;
    readonly siyuanHTML: string;
    readonly version: typeof SIYUAN_CLIPBOARD_VERSION;
}

interface ParsedSiyuanClipboardData {
    readonly sourceIdentity?: ProtyleClipboardSourceIdentity;
    readonly textHtml: string;
    readonly textSiyuan: string;
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

const parseClipboardPayload = (value: unknown): SiyuanClipboardPayload | undefined => {
    if (!value || typeof value !== "object") {
        return;
    }
    const payload = value as Record<string, unknown>;
    const source = payload.source;
    if (payload.version !== SIYUAN_CLIPBOARD_VERSION ||
        typeof payload.siyuanHTML !== "string" ||
        !source || typeof source !== "object") {
        return;
    }
    const identity = source as Record<string, unknown>;
    if (typeof identity.spaceId !== "string" || identity.spaceId === "" ||
        typeof identity.notebookId !== "string" || identity.notebookId === "" ||
        typeof identity.documentId !== "string" || identity.documentId === "") {
        return;
    }
    return {
        version: SIYUAN_CLIPBOARD_VERSION,
        source: {
            spaceId: identity.spaceId,
            notebookId: identity.notebookId,
            documentId: identity.documentId,
        },
        siyuanHTML: payload.siyuanHTML,
    };
};

export const createSiyuanClipboardHTML = (
    siyuanHTML: string,
    sourceIdentity: ProtyleClipboardSourceIdentity,
    html: string,
) => {
    const payload: SiyuanClipboardPayload = {
        version: SIYUAN_CLIPBOARD_VERSION,
        source: sourceIdentity,
        siyuanHTML,
    };
    return `<!--data-siyuan='${encodeBase64(JSON.stringify(payload))}'-->${html}`;
};

export const getTextSiyuanFromTextHTML = (html: string): ParsedSiyuanClipboardData => {
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
        const payload = parseClipboardPayload(JSON.parse(new TextDecoder().decode(bytes)));
        if (!payload) {
            throw new Error("clipboard payload does not match version 1");
        }
        return {
            sourceIdentity: payload.source,
            textSiyuan: payload.siyuanHTML,
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
            value.sourceIdentity = parsed.sourceIdentity;
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
