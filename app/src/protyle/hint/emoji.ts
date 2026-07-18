import {escapeAttr} from "../../util/escape";
import {emojiCodepointsToString} from "../util/emojiUnicode";
import {resolveProtyleEmojiPath} from "../util/emojiPath";

type EmojiGroup = TProtyleApplicationSettingsPort["emojis"][number];
type EmojiItem = EmojiGroup["items"][number];

const isDynamicIcon = (unicode: string) => unicode.startsWith("api/icon/getDynamicIcon");
const isCustomEmoji = (unicode: string) => !isDynamicIcon(unicode) && unicode.includes(".");

const localizedEmojiValue = (
    protyle: IProtyle,
    value: {readonly description?: string; readonly description_ja_jp?: string; readonly description_zh_cn?: string;
        readonly title?: string; readonly title_ja_jp?: string; readonly title_zh_cn?: string},
    type: "description" | "title",
) => {
    const language = protyle.localization.language.replace("-", "_").toLowerCase();
    if (type === "description") {
        if (language.startsWith("zh_cn")) {
            return value.description_zh_cn;
        }
        if (language.startsWith("ja")) {
            return value.description_ja_jp;
        }
        return value.description;
    }
    if (language.startsWith("zh_cn")) {
        return value.title_zh_cn;
    }
    if (language.startsWith("ja")) {
        return value.title_ja_jp;
    }
    return value.title;
};

export const getEmojiDescription = (protyle: IProtyle, emoji: EmojiItem) =>
    localizedEmojiValue(protyle, emoji, "description")!;

export const getEmojiGroupTitle = (protyle: IProtyle, index: number) =>
    localizedEmojiValue(protyle, protyle.settings.emojis[index], "title")!;

const groupIcons: Readonly<Record<string, string>> = {
    activity: "1f3a8",
    custom: "1f527",
    flags: "1f6a9",
    food: "1f96a",
    nature: "1f433",
    objects: "1f52e",
    people: "1f60d",
    symbols: "267e-fe0f",
    travel: "1f3dd-fe0f",
};

export const getEmojiGroupIcon = (group: EmojiGroup) => groupIcons[group.id];

export const unicodeToEmoji = (
    protyle: IProtyle,
    unicode: string,
    className = "",
    needSpan = false,
    lazy = false,
) => {
    if (!unicode) {
        return "";
    }
    if (isDynamicIcon(unicode)) {
        if (protyle.content.mode === "bound") {
            const icon = `<svg data-type="unsupported-dynamic-icon" role="img" aria-label="${escapeAttr(protyle.localization.text("dynamicIcon"))}"><use xlink:href="#iconCalendar"></use></svg>`;
            return needSpan || className
                ? `<span class="${escapeAttr(className)}" data-type="unsupported-dynamic-icon">${icon}</span>`
                : icon;
        }
        return Lute.Sanitize(`<img class="${escapeAttr(className)}" ${lazy ? "data-" : ""}src="${escapeAttr(unicode)}"/>`);
    }
    if (isCustomEmoji(unicode)) {
        const source = resolveProtyleEmojiPath(protyle, unicode);
        return Lute.Sanitize(`<img class="${escapeAttr(className)}" ${lazy ? "data-" : ""}src="${escapeAttr(source)}"/>`);
    }
    const emoji = emojiCodepointsToString(unicode);
    return needSpan ? `<span class="${escapeAttr(className)}">${emoji}</span>` : emoji;
};

export const emojiContentHTML = (protyle: IProtyle, unicode: string) => {
    if (isCustomEmoji(unicode)) {
        const name = unicode.split(".")[0];
        const source = resolveProtyleEmojiPath(protyle, unicode);
        return `<img alt="${escapeAttr(name)}" class="emoji" src="${escapeAttr(source)}" title="${escapeAttr(name)}">`;
    }
    return unicodeToEmoji(protyle, unicode, "emoji");
};

export const emojiInsertionHTML = (protyle: IProtyle, unicode: string) => {
    if (isCustomEmoji(unicode)) {
        return `${emojiContentHTML(protyle, unicode)} `;
    }
    return protyle.lute.SpinBlockDOM(emojiContentHTML(protyle, unicode) + " ");
};

export const renderEmojiItems = (protyle: IProtyle, items: readonly EmojiItem[], lazy = false) => items.map((emoji) =>
    `<button data-unicode="${escapeAttr(emoji.unicode)}" class="emojis__item ariaLabel" aria-label="${escapeAttr(getEmojiDescription(protyle, emoji))}">${unicodeToEmoji(protyle, emoji.unicode, "", false, lazy)}</button>`
).join("");

const observeUntilLoaded = (
    selector: string,
    element: Element,
    load: (target: HTMLElement) => boolean,
    signal: AbortSignal,
) => {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if ((entry.isIntersecting || entry.intersectionRatio !== 0) && load(entry.target as HTMLElement)) {
                observer.unobserve(entry.target);
            }
        });
    });
    element.querySelectorAll<HTMLElement>(selector).forEach((target) => observer.observe(target));
    signal.addEventListener("abort", () => observer.disconnect(), {once: true});
};

export const lazyLoadEmojiGroups = (
    protyle: IProtyle,
    element: HTMLElement,
    signal = protyle.requestSignal,
) => {
    observeUntilLoaded(".emojis__content[data-index]", element, (target) => {
        const index = Number(target.dataset.index);
        target.innerHTML = renderEmojiItems(protyle, protyle.settings.emojis[index].items);
        target.removeAttribute("data-index");
        target.style.minHeight = "";
        return true;
    }, signal);
};

export const lazyLoadEmojiImages = (
    protyle: IProtyle,
    element: Element,
    signal = protyle.requestSignal,
) => {
    observeUntilLoaded("img[data-src]", element, (target) => {
        const image = target as HTMLImageElement;
        image.src = image.dataset.src!;
        image.removeAttribute("data-src");
        return true;
    }, signal);
};

const matchesEmoji = (protyle: IProtyle, emoji: EmojiItem, key: string) => {
    const normalized = key.toLowerCase();
    return unicodeToEmoji(protyle, emoji.unicode) === key ||
        emoji.keywords.toLowerCase().includes(normalized) ||
        emoji.description.toLowerCase().includes(normalized) ||
        emoji.description_zh_cn.toLowerCase().includes(normalized) ||
        emoji.description_ja_jp.toLowerCase().includes(normalized);
};

const recentEmojiItems = (protyle: IProtyle, key?: string): EmojiItem[] => {
    const byUnicode = new Map<string, EmojiItem>();
    protyle.settings.emojis.forEach((group) => group.items.forEach((item) => byUnicode.set(item.unicode, item)));
    return protyle.settings.recentEmojis.values.flatMap((unicode) => {
        const item = byUnicode.get(unicode);
        return item && (!key || matchesEmoji(protyle, item, key)) ? [item] : [];
    });
};

const compareCustomEmoji = (key: string) => (left: EmojiItem, right: EmojiItem) => {
    const normalized = key.toLowerCase();
    const leftKeywords = left.keywords.split("/");
    const rightKeywords = right.keywords.split("/");
    const leftKeyword = leftKeywords[leftKeywords.length - 1].toLowerCase();
    const rightKeyword = rightKeywords[rightKeywords.length - 1].toLowerCase();
    const positionDifference = leftKeyword.indexOf(normalized) - rightKeyword.indexOf(normalized);
    return positionDifference || leftKeyword.length - rightKeyword.length;
};

export const filterEmoji = (protyle: IProtyle, key = "", max?: number) => {
    if (!key) {
        const recent = recentEmojiItems(protyle);
        let html = recent.length === 0
            ? ""
            : `<div class="emojis__title" data-type="0">${protyle.localization.text("recentEmoji")}</div><div class="emojis__content">${renderEmojiItems(protyle, recent, true)}</div>`;
        protyle.settings.emojis.forEach((group, index) => {
            html += `<div class="emojis__title" data-type="${index + 1}">${getEmojiGroupTitle(protyle, index)}</div>`;
            html += index < 2
                ? `<div class="emojis__content">${renderEmojiItems(protyle, group.items, true)}</div>`
                : `<div style="min-height:300px" class="emojis__content" data-index="${index}"></div>`;
        });
        return html || `<div class="emojis__title">${protyle.localization.text("emptyContent")}</div>`;
    }

    const customMatches: EmojiItem[] = [];
    const standardMatches: EmojiItem[] = [];
    let matchCount = 0;
    for (const group of protyle.settings.emojis) {
        for (const emoji of group.items) {
            if (max && matchCount >= max) {
                break;
            }
            if (matchesEmoji(protyle, emoji, key)) {
                (group.id === "custom" ? customMatches : standardMatches).push(emoji);
                matchCount++;
            }
        }
        if (max && matchCount >= max) {
            break;
        }
    }
    customMatches.sort(compareCustomEmoji(key));
    const matches = customMatches.concat(standardMatches);
    const recent = recentEmojiItems(protyle, key);
    const recentHTML = recent.length === 0
        ? ""
        : `<div class="emojis__title" data-type="0">${protyle.localization.text("recentEmoji")}</div><div class="emojis__content">${renderEmojiItems(protyle, recent, true)}</div>`;
    const matchesHTML = matches.length === 0
        ? ""
        : `<div class="emojis__title">${protyle.localization.text("emoji")}</div><div class="emojis__content">${renderEmojiItems(protyle, matches, true)}</div>`;
    return recentHTML + matchesHTML || `<div class="emojis__title">${protyle.localization.text("emptyContent")}</div>`;
};
