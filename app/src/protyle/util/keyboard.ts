import {isMac} from "./browserPlatform";

const HOTKEY_LABELS: Record<string, string> = {
    "⇥": "Tab",
    "⌫": "Backspace",
    "⌦": "Delete",
    "↩": "Enter",
};

export const isOnlyMeta = (event: KeyboardEvent | MouseEvent) =>
    isMac()
        ? event.metaKey && !event.ctrlKey
        : !event.metaKey && event.ctrlKey;

export const isNotCtrl = (event: KeyboardEvent | MouseEvent) =>
    !event.metaKey && !event.ctrlKey;

export const updateHotkeyTip = (hotkey: string) => {
    if (!hotkey || isMac()) {
        return hotkey;
    }
    const keys: string[] = [];
    if (hotkey.includes("⌘") || hotkey.includes("⌃")) {
        keys.push("Ctrl");
    }
    if (hotkey.includes("⇧")) {
        keys.push("Shift");
    }
    if (hotkey.includes("⌥")) {
        keys.push("Alt");
    }
    const lastKey = hotkey.replace(/[⌘⇧⌥⌃]/g, "");
    if (lastKey) {
        keys.push(HOTKEY_LABELS[lastKey] || lastKey);
    }
    return keys.join("+");
};

export const updateHotkeyAfterTip = (hotkey: string, split = " ") =>
    hotkey ? split + updateHotkeyTip(hotkey) : "";
