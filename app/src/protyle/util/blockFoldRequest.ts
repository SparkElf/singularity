import type {ProtyleContentIdentity} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {Constants} from "../../constants";

interface BlockFoldResponse {
    readonly data: {
        readonly isFolded: boolean;
        readonly isRoot: boolean;
    };
}

export interface BlockFoldResult {
    readonly action: TProtyleAction[];
    readonly isRoot: boolean;
    readonly zoomIn: boolean;
}

export interface BlockFoldTarget extends ProtyleContentIdentity {
    readonly blockId: string;
}

/** 查询指定块的折叠状态，并返回后续导航所需的最小动作集合。 */
export const requestBlockFold = async (
    protyle: IProtyle,
    target: BlockFoldTarget,
): Promise<BlockFoldResult> => {
    const response = await protyle.runtime.transport.request<BlockFoldResponse>(
        "/api/block/checkBlockFold",
        {id: target.blockId},
        {
            identity: {
                documentId: target.documentId,
                notebookId: target.notebookId,
            },
            intent: "read",
            signal: protyle.requestSignal,
        },
    );
    return {
        action: response.data.isFolded
            ? [Constants.CB_GET_FOCUS, Constants.CB_GET_ALL]
            : [Constants.CB_GET_FOCUS, Constants.CB_GET_CONTEXT, Constants.CB_GET_ROOTSCROLL],
        isRoot: response.data.isRoot,
        zoomIn: response.data.isFolded,
    };
};
