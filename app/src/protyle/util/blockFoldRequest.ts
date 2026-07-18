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

export const requestBlockFold = async (
    protyle: IProtyle,
    identity: ProtyleContentIdentity,
): Promise<BlockFoldResult> => {
    const response = await protyle.session!.runtime.transport.request<BlockFoldResponse>(
        "/api/block/checkBlockFold",
        {id: identity.documentId},
        {
            identity,
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
