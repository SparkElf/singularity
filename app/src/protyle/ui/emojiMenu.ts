import {escapeAttr} from "../../util/escape";
import {isNarrowViewport} from "../util/browserPlatform";
import {
    filterEmoji,
    getEmojiGroupIcon,
    getEmojiGroupTitle,
    lazyLoadEmojiGroups,
    lazyLoadEmojiImages,
    renderEmojiItems,
    unicodeToEmoji,
} from "../hint/emoji";

interface OpenProtyleEmojiMenuOptions {
    readonly onSelect: (unicode: string, signal: AbortSignal) => void | Promise<void>;
    readonly position: IPosition;
    readonly protyle: IProtyle;
}

const randomEmoji = (protyle: IProtyle) => {
    const count = protyle.settings.emojis.reduce((total, group) => total + group.items.length, 0);
    let index = Math.floor(Math.random() * count);
    for (const group of protyle.settings.emojis) {
        if (index < group.items.length) {
            return group.items[index].unicode;
        }
        index -= group.items.length;
    }
    return "";
};

export const openProtyleEmojiMenu = ({
    onSelect,
    position,
    protyle,
}: OpenProtyleEmojiMenuOptions) => {
    const handle = protyle.runtime.menu.open();
    const lifecycle = new AbortController();
    handle.menu.removeCB = () => lifecycle.abort();
    protyle.requestSignal.addEventListener("abort", () => handle.close(), {
        once: true,
        signal: lifecycle.signal,
    });

    const navigation = [
        protyle.settings.recentEmojis.values.length === 0
            ? ""
            : `<button type="button" data-type="0" class="emojis__type ariaLabel" aria-label="${escapeAttr(protyle.localization.text("recentEmoji"))}">${unicodeToEmoji(protyle, "2b50")}</button>`,
        ...protyle.settings.emojis.flatMap((group, index) => {
            const icon = getEmojiGroupIcon(group);
            return icon
                ? [`<button type="button" data-type="${index + 1}" class="emojis__type ariaLabel" aria-label="${escapeAttr(getEmojiGroupTitle(protyle, index))}">${unicodeToEmoji(protyle, icon)}</button>`]
                : [];
        }),
    ].join("");
    const hasEmoji = protyle.settings.emojis.some((group) => group.items.length > 0);
    const root = handle.menu.addItem({
        type: "empty",
        label: `<div style="padding:0;max-height:min(402px,50vh);width:366px" class="emojis">
<div class="fn__flex" style="padding:8px 8px 0">
    <label class="b3-form__icon fn__flex-1">
        <svg class="b3-form__icon-icon"><use xlink:href="#iconSearch"></use></svg>
        <input class="b3-form__icon-input b3-text-field fn__block" placeholder="${escapeAttr(protyle.localization.text("search"))}">
    </label>
    <span class="fn__space"></span>
    <button type="button" data-action="random" class="block__icon block__icon--show ariaLabel" aria-label="${escapeAttr(protyle.localization.text("random"))}"${hasEmoji ? "" : " disabled"}><svg><use xlink:href="#iconRefresh"></use></svg></button>
    <button type="button" data-action="remove" class="block__icon block__icon--show ariaLabel" aria-label="${escapeAttr(protyle.localization.text("remove"))}"><svg><use xlink:href="#iconTrashcan"></use></svg></button>
</div>
<div class="emojis__panel">${filterEmoji(protyle)}</div>
<div class="fn__flex">${navigation}</div>
</div>`,
        bind: (element) => {
            const container = element.querySelector<HTMLElement>(".emojis")!;
            const input = container.querySelector<HTMLInputElement>("input")!;
            const panel = container.querySelector<HTMLElement>(".emojis__panel")!;
            const navigationElement = panel.nextElementSibling as HTMLElement;
            let selecting = false;

            const select = async (unicode: string) => {
                if (selecting) {
                    return;
                }
                selecting = true;
                try {
                    await onSelect(unicode, lifecycle.signal);
                    if (unicode && !lifecycle.signal.aborted) {
                        await protyle.settings.recentEmojis.add(unicode);
                    }
                } catch (error) {
                    console.error("[protyle.emoji] selection failed", error);
                } finally {
                    handle.close();
                }
            };
            const selectFirst = () => {
                container.querySelector(".emojis__item--current")?.classList.remove("emojis__item--current");
                container.querySelector(".emojis__item")?.classList.add("emojis__item--current");
            };
            const renderSearch = () => {
                panel.innerHTML = filterEmoji(protyle, input.value, 256);
                navigationElement.classList.toggle("fn__none", input.value.length > 0);
                panel.scrollTop = 0;
                lazyLoadEmojiImages(protyle, panel, lifecycle.signal);
                selectFirst();
            };
            const moveCurrent = (direction: "down" | "left" | "right" | "up") => {
                const items = Array.from(panel.querySelectorAll<HTMLElement>(".emojis__item"));
                if (items.length === 0) {
                    return;
                }
                const current = panel.querySelector<HTMLElement>(".emojis__item--current") ?? items[0];
                const currentIndex = items.indexOf(current);
                const columns = Math.max(1, Math.floor(panel.clientWidth / Math.max(current.clientWidth, 1)));
                const offset = direction === "left" ? -1 : direction === "right" ? 1 : direction === "up" ? -columns : columns;
                const next = items[Math.max(0, Math.min(items.length - 1, currentIndex + offset))];
                current.classList.remove("emojis__item--current");
                next.classList.add("emojis__item--current");
                next.scrollIntoView({block: "nearest"});
            };

            input.addEventListener("compositionend", renderSearch, {signal: lifecycle.signal});
            input.addEventListener("input", (event) => {
                if (!(event as InputEvent).isComposing) {
                    renderSearch();
                }
            }, {signal: lifecycle.signal});
            input.addEventListener("keydown", (event) => {
                if (event.isComposing) {
                    return;
                }
                if (event.key === "Enter") {
                    const current = panel.querySelector<HTMLElement>(".emojis__item--current");
                    if (current) {
                        void select(current.dataset.unicode!);
                        event.preventDefault();
                        event.stopPropagation();
                    }
                    return;
                }
                const direction = ({
                    ArrowDown: "down",
                    ArrowLeft: "left",
                    ArrowRight: "right",
                    ArrowUp: "up",
                } as Readonly<Record<string, "down" | "left" | "right" | "up">>)[event.key];
                if (direction) {
                    moveCurrent(direction);
                    event.preventDefault();
                    event.stopPropagation();
                }
            }, {signal: lifecycle.signal});
            container.addEventListener("click", (event) => {
                const target = event.target as Element;
                const item = target.closest<HTMLElement>(".emojis__item");
                if (item) {
                    void select(item.dataset.unicode!);
                    return;
                }
                const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
                if (action === "remove") {
                    void select("");
                    return;
                }
                if (action === "random") {
                    void select(randomEmoji(protyle));
                    return;
                }
                const type = target.closest<HTMLElement>(".emojis__type")?.dataset.type;
                if (!type) {
                    return;
                }
                const title = panel.querySelector<HTMLElement>(`.emojis__title[data-type="${type}"]`);
                if (!title) {
                    return;
                }
                const content = title.nextElementSibling as HTMLElement;
                if (content.dataset.index) {
                    const index = Number(content.dataset.index);
                    content.innerHTML = renderEmojiItems(protyle, protyle.settings.emojis[index].items, true);
                    content.removeAttribute("data-index");
                    content.style.minHeight = "";
                    lazyLoadEmojiImages(protyle, content, lifecycle.signal);
                }
                panel.scrollTop = title.offsetTop;
            }, {signal: lifecycle.signal});

            lazyLoadEmojiGroups(protyle, container, lifecycle.signal);
            lazyLoadEmojiImages(protyle, container, lifecycle.signal);
            selectFirst();
            if (!isNarrowViewport()) {
                input.focus();
            }
        },
    });
    if (!root) {
        handle.close();
        return undefined;
    }
    if (isNarrowViewport()) {
        handle.menu.fullscreen("bottom");
    } else {
        handle.menu.popup(position);
    }
    return handle;
};
