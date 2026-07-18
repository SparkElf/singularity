import {Constants} from "../../constants";

type ToolbarHotkeys = IProtyle["settings"]["toolbar"]["hotkeys"];

export const toolbarKeyToMenu = (toolbar: Array<string | IMenuItem>, hotkeys: ToolbarHotkeys) => {
    const toolbarItems: IMenuItem[] = [{
        name: "block-ref",
        hotkey: hotkeys.ref,
        lang: "ref",
        icon: "iconRef",
        tipPosition: "ne",
    }, {
        name: "a",
        hotkey: hotkeys.link,
        lang: "link",
        icon: "iconLink",
        tipPosition: "n",
    }, {
        name: "strong",
        lang: "bold",
        hotkey: hotkeys.bold,
        icon: "iconBold",
        tipPosition: "n",
    }, {
        name: "em",
        lang: "italic",
        hotkey: hotkeys.italic,
        icon: "iconItalic",
        tipPosition: "n",
    }, {
        name: "u",
        lang: "underline",
        hotkey: hotkeys.underline,
        icon: "iconUnderline",
        tipPosition: "n",
    }, {
        name: "s",
        lang: "strike",
        hotkey: hotkeys.strike,
        icon: "iconStrike",
        tipPosition: "n",
    }, {
        name: "mark",
        lang: "mark",
        hotkey: hotkeys.mark,
        icon: "iconMark",
        tipPosition: "n",
    }, {
        name: "sup",
        lang: "sup",
        hotkey: hotkeys.sup,
        icon: "iconSup",
        tipPosition: "n",
    }, {
        name: "sub",
        lang: "sub",
        hotkey: hotkeys.sub,
        icon: "iconSub",
        tipPosition: "n",
    }, {
        name: "kbd",
        lang: "kbd",
        hotkey: hotkeys.kbd,
        icon: "iconKeymap",
        tipPosition: "n",
    }, {
        name: "tag",
        lang: "tag",
        hotkey: hotkeys.tag,
        icon: "iconTag",
        tipPosition: "n",
    }, {
        name: "code",
        lang: "inline-code",
        hotkey: hotkeys["inline-code"],
        icon: "iconInlineCode",
        tipPosition: "n",
    }, {
        name: "inline-math",
        lang: "inline-math",
        hotkey: hotkeys["inline-math"],
        icon: "iconMath",
        tipPosition: "n",
    }, {
        name: "inline-memo",
        lang: "memo",
        hotkey: hotkeys.memo,
        icon: "iconM",
        tipPosition: "n",
    }, {
        name: "text",
        lang: "appearance",
        hotkey: hotkeys.appearance,
        icon: "iconFont",
        tipPosition: "n",
    }, {
        name: "clear",
        lang: "clearInline",
        hotkey: hotkeys.clearInline,
        icon: "iconClear",
        tipPosition: "n",
    }, {
        name: "|",
    }];
    return toolbar.map((menuItem: string | IMenuItem) => {
        const defaultItem = toolbarItems.find((candidate) => candidate.name ===
            (typeof menuItem === "string" ? menuItem : menuItem.name));
        return typeof menuItem === "object" && defaultItem
            ? Object.assign({}, defaultItem, menuItem)
            : defaultItem || menuItem;
    }) as IMenuItem[];
};

export const resolveLinkDest = (value: string, lute: Lute): string =>
    value.startsWith("assets/") ? value : lute.GetLinkDest(value);

export const genLinkText = (href: string, stripScheme = true, decodeURI = false): string => {
    try {
        let value = stripScheme
            ? href.replace("https://", "").replace("http://", "")
            : href;
        if (decodeURI) {
            value = decodeURIComponent(value);
        }
        return value.length > Constants.SIZE_LINK_TEXT_MAX
            ? value.substring(0, Constants.SIZE_LINK_TEXT_MAX) + "..."
            : value;
    } catch {
        return href;
    }
};
