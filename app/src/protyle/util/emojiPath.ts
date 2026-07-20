import {protyleContentIdentity} from "./contentLoad";

/** 按当前编辑器的内容身份解析表情资源，local-only 编辑器使用本地表情目录。 */
export const resolveProtyleEmojiPath = (protyle: IProtyle, path: string) => {
    if (protyle.content.mode === "bound") {
        return protyle.runtime.resources.resolveEmoji(protyleContentIdentity(protyle), path);
    }
    return `${protyle.options.hint.emojiPath}/${path}`;
};
