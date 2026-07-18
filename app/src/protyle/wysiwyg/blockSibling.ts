import {protyleContentIdentity} from "../util/contentLoad";

export type BlockSibling = "next" | "parent" | "previous";

interface BlockSiblingResponse {
    readonly data: Partial<Record<BlockSibling, string>>;
}

export const requestBlockSibling = (
    protyle: IProtyle,
    id: string,
) => protyle.session!.runtime.transport.request<BlockSiblingResponse>("/api/block/getBlockSiblingID", {
    id,
    notebook: protyle.notebookId,
}, {
    identity: protyleContentIdentity(protyle),
    intent: "read",
    signal: protyle.requestSignal,
});
