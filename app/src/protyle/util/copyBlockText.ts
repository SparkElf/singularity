import {writeText} from "./clipboard";
import {protyleContentIdentity} from "./contentLoad";
import {buildSiYuanBlockUri} from "./blockUri";

export type BlockTextFormat = "blockEmbed" | "id" | "protocol" | "protocolMd";

interface TextResponse {
    readonly data: string;
}

const requestRefText = (protyle: IProtyle, id: string) =>
    protyle.session!.runtime.transport.request<TextResponse>("/api/block/getRefText", {id}, {
        identity: protyleContentIdentity(protyle),
        intent: "read",
        signal: protyle.requestSignal,
    });

export const copyBlockText = async (
    protyle: IProtyle,
    ids: readonly string[],
    format: BlockTextFormat,
) => {
    const identity = protyleContentIdentity(protyle);
    let text = "";
    for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        if (ids.length > 1) {
            text += "- ";
        }
        switch (format) {
            case "blockEmbed":
                text += `{{select * from blocks where id='${id}'}}`;
                break;
            case "id":
                text += id;
                break;
            case "protocol":
                text += buildSiYuanBlockUri(id, identity.notebookId);
                break;
            case "protocolMd": {
                const response = await requestRefText(protyle, id);
                text += `[${response.data.replace("[", "\\[").replace("]", "\\]")}](${buildSiYuanBlockUri(id, identity.notebookId)})`;
                break;
            }
        }
        if (index < ids.length - 1) {
            text += "\n";
        }
    }
    await writeText(text);
};
