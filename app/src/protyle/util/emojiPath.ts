import {protyleContentIdentity} from "./contentLoad";

export const resolveProtyleEmojiPath = (protyle: IProtyle, path: string) => {
    if (protyle.content.mode === "bound") {
        return protyle.session!.runtime.resources.resolveEmoji(protyleContentIdentity(protyle), path);
    }
    return `${protyle.options.hint.emojiPath}/${path}`;
};
