import {Constants} from "../constants";
import {fetchPost} from "../util/fetch";

export const getRecentEmojis = (): readonly string[] => window.siyuan.config.editor.emoji;

export const addRecentEmoji = (unicode: string) => {
    const emojis = window.siyuan.config.editor.emoji;
    const previousIndex = emojis.indexOf(unicode);
    if (previousIndex !== -1) {
        emojis.splice(previousIndex, 1);
    }
    emojis.unshift(unicode);
    if (emojis.length > Constants.SIZE_UNDO) {
        emojis.pop();
    }
    fetchPost("/api/setting/setEmoji", {emoji: emojis});
};
