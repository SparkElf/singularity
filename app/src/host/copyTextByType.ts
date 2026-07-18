import {fetchSyncPost} from "../util/fetch";
import {writeText} from "../protyle/util/compatibility";
import {buildSiYuanBlockUri} from "../protyle/util/blockUri";

export const copyTextByType = async (
    ids: string[],
    type: "ref" | "blockEmbed" | "protocol" | "protocolMd" | "hPath" | "id" | "webURL",
    notebookId?: string,
) => {
    if ((type === "protocol" || type === "protocolMd" || type === "hPath" || type === "webURL") && !notebookId) {
        console.error("[Singularity/ProtyleIdentity] document link copy requires notebookId", {blockIds: ids});
        return;
    }
    let text = "";
    for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        if (ids.length > 1) {
            text += "- ";
        }
        if (type === "ref") {
            const response = await fetchSyncPost("/api/block/getRefText", {id});
            text += `((${id} '${response.data}'))`;
        } else if (type === "blockEmbed") {
            text += `{{select * from blocks where id='${id}'}}`;
        } else if (type === "protocol") {
            text += buildSiYuanBlockUri(id, notebookId);
        } else if (type === "protocolMd") {
            const response = await fetchSyncPost("/api/block/getRefText", {id});
            text += `[${response.data.replace("[", "\\[").replace("]", "\\]")}](` +
                `${buildSiYuanBlockUri(id, notebookId)})`;
        } else if (type === "hPath") {
            const response = await fetchSyncPost("/api/filetree/getHPathByID", {id, notebook: notebookId});
            text += response.data;
        } else if (type === "webURL") {
            text += `${window.location.origin}?id=${id}&notebook=${encodeURIComponent(notebookId)}`;
        } else if (type === "id") {
            text += id;
        }
        if (ids.length > 1 && index !== ids.length - 1) {
            text += "\n";
        }
    }
    await writeText(text);
};
