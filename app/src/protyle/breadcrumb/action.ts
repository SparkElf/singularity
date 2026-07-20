import {addLoading} from "../ui/initUI";
import {Constants} from "../../constants";
import {hideElements} from "../ui/hideElements";
import {disabledProtyle, enableProtyle} from "../util/onGet";
import {protyleContentIdentity} from "../util/contentLoad";
import {setApplicationReadOnly, setDocumentReadOnlyAttribute} from "../runtime/readOnly";

const reportBreadcrumbActionFailure = (protyle: IProtyle, action: string, error: unknown) => {
    if (!protyle.requestSignal.aborted) {
        console.error(`[protyle.breadcrumb] ${action} failed`, error);
    }
};

const applyReadOnlyState = (protyle: IProtyle) => {
    if (protyle.readonlyState.host || protyle.readonlyState.application || protyle.readonlyState.document) {
        disabledProtyle(protyle);
    } else {
        enableProtyle(protyle);
    }
};

export const net2LocalAssets = (protyle: IProtyle, type: "Assets" | "Img") => {
    if (protyle.element.querySelector(".wysiwygLoading")) {
        return;
    }
    addLoading(protyle);
    hideElements(["toolbar"], protyle);
    void protyle.runtime.transport.request<IWebSocketData>(`/api/format/net${type}2LocalAssets`, {
        id: protyle.block.rootID
    }, {
        identity: protyleContentIdentity(protyle),
        intent: "write",
        signal: protyle.requestSignal,
    }).catch((error) => {
        reportBreadcrumbActionFailure(protyle, `localize network ${type.toLowerCase()}`, error);
    });
};

export const updateReadonly = (target: Element, protyle: IProtyle) => {
    if (protyle.readonlyState.host || protyle.element.getAttribute("disabled-forever") === "true") {
        return;
    }
    const currentlyReadOnly = target.querySelector("use").getAttribute("xlink:href") !== "#iconUnlock";
    if (protyle.settings.editor.readOnly) {
        setApplicationReadOnly(protyle.readonlyState, !currentlyReadOnly);
        applyReadOnlyState(protyle);
        return;
    }
    const identity = protyleContentIdentity(protyle);
    const requestedReadOnly = !currentlyReadOnly;
    void setDocumentReadOnlyAttribute(protyle.readonlyState, requestedReadOnly, async (readOnly) => {
        await protyle.runtime.transport.request<IWebSocketData>("/api/attr/setBlockAttrs", {
            id: protyle.block.rootID,
            attrs: {[Constants.CUSTOM_SY_READONLY]: readOnly ? "true" : "false"},
        }, {
            identity,
            intent: "write",
            signal: protyle.requestSignal,
        });
        const response = await protyle.runtime.transport.request<IWebSocketData>("/api/block/getDocInfo", {
            id: protyle.block.rootID,
            notebook: identity.notebookId,
        }, {
            identity,
            intent: "read",
            signal: protyle.requestSignal,
        });
        return response.data.ial[Constants.CUSTOM_SY_READONLY] === "true";
    }).then(() => {
        if (!protyle.requestSignal.aborted) {
            applyReadOnlyState(protyle);
        }
    }).catch((error) => {
        if (!protyle.requestSignal.aborted) {
            reportBreadcrumbActionFailure(protyle, "update document read-only", error);
            applyReadOnlyState(protyle);
        }
    });
};
