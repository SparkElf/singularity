import {Constants} from "../../constants";
import {fetchSyncPost} from "../../util/fetch";
import {confirmDialog} from "../../dialog/confirmDialog";
import {showMessage} from "../../dialog/message";
import {GlobalUndoState, UndoDocumentIdentity} from "./globalUndoState";

// 本地镜像：按 notebook + rootID 缓存 {canUndo, canRedo}，按钮态零 fetch 读取。
// 在编辑（add 落点）、撤销/重做响应、WS 广播（context.undoState）时更新。
const globalUndoState = new GlobalUndoState();

const documentIdentity = (notebookId: string, rootID: string): UndoDocumentIdentity => ({notebookId, rootID});

const currentDocumentIdentity = (protyle: IProtyle): UndoDocumentIdentity | undefined => {
    if (protyle.destroyed || !protyle.block?.rootID) {
        return;
    }
    return documentIdentity(protyle.notebookId, protyle.block.rootID);
};

interface UndoOwnerScope {
    readonly signal: AbortSignal;
    release: () => void;
}

const createOwnerScope = (protyle: IProtyle, identity: UndoDocumentIdentity): UndoOwnerScope => {
    const controller = new AbortController();
    const sourceSignals = Array.from(new Set([
        protyle.ownerSignal,
        protyle.uiEventController?.signal,
    ].filter((signal): signal is AbortSignal => !!signal)));
    const abort = () => controller.abort();
    sourceSignals.forEach((signal) => {
        if (signal.aborted) {
            abort();
        } else {
            signal.addEventListener("abort", abort, {once: true});
        }
    });
    if (!globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
        abort();
    }
    return {
        signal: controller.signal,
        release: () => sourceSignals.forEach((signal) => signal.removeEventListener("abort", abort)),
    };
};

export const markMirror = (notebookId: string, rootID: string,
                           state: Partial<{ canUndo: boolean; canRedo: boolean }>) => {
    globalUndoState.mark(documentIdentity(notebookId, rootID), state);
};

export const getMirror = (notebookId: string, rootID: string) => {
    return globalUndoState.get(documentIdentity(notebookId, rootID));
};

// 从 WS 广播 context.undoState 批量更新镜像（多窗口/多端同步）
export const syncMirrorFromBroadcast = (notebook: string,
                                        undoState: { [rootID: string]: { canUndo: boolean; canRedo: boolean } }) => {
    if (!undoState) {
        return;
    }
    globalUndoState.sync(notebook, undoState);
};

// 文档打开时主动初始化镜像（低频，不在 selectionchange 热路径）
export const initMirror = async (protyle: IProtyle) => {
    const identity = currentDocumentIdentity(protyle);
    if (!identity) {
        return;
    }
    const initialization = globalUndoState.beginInitialization(identity);
    const owner = createOwnerScope(protyle, identity);
    try {
        const response = await postUndoRequest("/api/transactions/undoState", {
            notebook: identity.notebookId,
            rootID: identity.rootID,
        }, owner.signal);
        const data = response.data;
        if (data && !owner.signal.aborted &&
            globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
            globalUndoState.applyInitialization(initialization, {
                canUndo: !!data.canUndo,
                canRedo: !!data.canRedo,
            });
        }
    } catch (error) {
        if (!owner.signal.aborted) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[global-undo] mirror initialization failed: ${message}`);
        }
    } finally {
        owner.release();
    }
};

// 刷新指定 protyle 的撤销/重做按钮态（读镜像，零 fetch）
export const refreshUndoButtons = (protyle: IProtyle) => {
    if (!protyle.block?.rootID) {
        return;
    }
    const state = getMirror(protyle.notebookId, protyle.block.rootID);
    if (protyle.breadcrumb) {
        const parent = protyle.breadcrumb.element.parentElement;
        const undoElement = parent.querySelector('[data-type="undo"]') as HTMLElement;
        const redoElement = parent.querySelector('[data-type="redo"]') as HTMLElement;
        if (undoElement) {
            if (state.canUndo) {
                undoElement.removeAttribute("disabled");
            } else {
                undoElement.setAttribute("disabled", "disabled");
            }
        }
        if (redoElement) {
            if (state.canRedo) {
                redoElement.removeAttribute("disabled");
            } else {
                redoElement.setAttribute("disabled", "disabled");
            }
        }
    }
};

// 解析 rootID 列表为文档名，用于跨文档撤销确认提示
const postUndoRequest = async (url: string, data: IObject, signal: AbortSignal): Promise<IWebSocketData> => {
    const response = await fetchSyncPost(url, data, undefined, {processResponse: false, signal});
    if (response.code !== 0) {
        throw new Error(response.msg || `${url} failed with code ${response.code}`);
    }
    return response;
};

const reportRequestError = (action: "undo" | "redo", error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[global-undo] ${action} failed: ${message}`);
    showMessage(message, 0, "error");
};

const resolveRootNames = async (identity: UndoDocumentIdentity, rootIDs: string[],
                                signal: AbortSignal): Promise<string[]> => {
    const names: string[] = [];
    for (const id of rootIDs) {
        const response = await postUndoRequest("/api/filetree/getHPathByID", {
            id,
            notebook: identity.notebookId,
        }, signal);
        names.push(response.data ? response.data as string : id);
    }
    return names;
};

const focusRootIDs = (editors: TProtyleEditorRegistry, identity: UndoDocumentIdentity,
                      rootIDs: string[], focusBlockId?: string) => {
    // 只滚动发起窗口的焦点 protyle 到变更块；其它文档不强制重开（撤销物理结果在发起文档）
    const protyle = editors.getActive();
    if (protyle && globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle)) &&
        rootIDs.includes(identity.rootID) && focusBlockId) {
        const target = protyle.wysiwyg.element.querySelector(`[data-node-id="${focusBlockId}"]`);
        if (target) {
            const rect = target.getBoundingClientRect();
            // 仅在变更块不在视口内时才滚动，避免打断用户当前的滚动位置
            if (rect.bottom < 0 || rect.top > window.innerHeight) {
                target.scrollIntoView({behavior: "smooth", block: "center"});
            }
        }
    }
};

const applyReplayResponse = (action: "undo" | "redo", protyle: IProtyle,
                             identity: UndoDocumentIdentity, response?: IWebSocketData) => {
    const data = response?.data;
    if (!data) {
        return;
    }
    if (data.failed) {
        showMessage(data.msg || `${action} failed`, 0, "error");
        return;
    }
    const replayOperations: IOperation[] = data.doOperations || [];
    markMirror(identity.notebookId, identity.rootID, {
        canUndo: !!data.canUndo,
        canRedo: !!data.canRedo,
    });
    if (replayOperations.length === 0) {
        refreshUndoButtons(protyle);
        return;
    }
    const mutatedRootIDs: string[] = data.mutatedRootIDs || [];
    if (mutatedRootIDs.length > 1) {
        // 跨文档重放由 kernel 广播刷新所有相关文档，不能在单个 Protyle 中乐观应用。
        refreshUndoButtons(protyle);
        return;
    }
    protyle.undo.renderLocal(protyle, replayOperations);
    refreshUndoButtons(protyle);
    const focusBlockId = replayOperations.find((operation) => operation.id)?.id;
    focusRootIDs(protyle.editors, identity, mutatedRootIDs, focusBlockId);
};

// 请求撤销：读镜像判可撤销 → 跨文档提示 → 调 kernel undo → 本地乐观应用 + 更新镜像
export const requestUndo = async (protyle: IProtyle) => {
    if (!protyle) {
        return;
    }
    const identity = currentDocumentIdentity(protyle);
    if (!identity) {
        return;
    }

    const state = globalUndoState.get(identity);
    if (!state.canUndo) {
        return; // 语义 B：栈空不做事
    }
    const session = protyle.id;
    const owner = createOwnerScope(protyle, identity);
    try {
        await globalUndoState.runRequest(identity, async () => {
            const stateResponse = await postUndoRequest("/api/transactions/undoState", {
                notebook: identity.notebookId,
                rootID: identity.rootID,
            }, owner.signal);
            const peekMutatedRootIDs: string[] = stateResponse.data?.peekMutatedRootIDs || [];
            if (!globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
                return;
            }
            if (peekMutatedRootIDs.length > 1) {
                const names = await resolveRootNames(identity, peekMutatedRootIDs, owner.signal);
                if (!globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
                    return;
                }
                const inputElement = protyle.wysiwyg.element;
                const blockInput = (event: Event) => {
                    event.stopImmediatePropagation();
                    event.preventDefault();
                };
                inputElement.addEventListener("keydown", blockInput, true);
                inputElement.addEventListener("beforeinput", blockInput, true);
                let confirmed = false;
                try {
                    confirmed = await new Promise<boolean>((resolve) => {
                        confirmDialog(`⚠️ ${window.siyuan.languages.undo}`,
                            `${window.siyuan.languages.undoCrossDocConfirm}<div style="margin-top: 8px;">${names.map(name => `• ${name}`).join("<br>")}</div>`,
                            () => resolve(true),
                            () => resolve(false),
                            false,
                            owner.signal);
                    });
                } finally {
                    inputElement.removeEventListener("keydown", blockInput, true);
                    inputElement.removeEventListener("beforeinput", blockInput, true);
                }
                if (!confirmed || !globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
                    return;
                }
            }
            // Owner cancellation only detaches this UI from the response. A mutation already admitted by the
            // kernel may still commit; its transaction broadcast is authoritative for later mirror convergence.
            return postUndoRequest("/api/transactions/undo", {
                notebook: identity.notebookId,
                rootID: identity.rootID,
                app: Constants.SIYUAN_APPID,
                session,
            }, owner.signal);
        }, () => currentDocumentIdentity(protyle), response => {
            applyReplayResponse("undo", protyle, identity, response);
        }, owner.signal);
    } catch (error) {
        if (!owner.signal.aborted) {
            reportRequestError("undo", error);
        }
    } finally {
        owner.release();
    }
};

// 请求重做：对称，redo 不提示（其逆已在 undo 中确认）
export const requestRedo = async (protyle: IProtyle) => {
    if (!protyle) {
        return;
    }
    const identity = currentDocumentIdentity(protyle);
    if (!identity) {
        return;
    }

    const state = globalUndoState.get(identity);
    if (!state.canRedo) {
        return;
    }
    const session = protyle.id;
    const owner = createOwnerScope(protyle, identity);
    try {
        // As with undo, aborting the response wait cannot roll back a kernel mutation that was already admitted.
        await globalUndoState.runRequest(identity, () => postUndoRequest("/api/transactions/redo", {
            notebook: identity.notebookId,
            rootID: identity.rootID,
            app: Constants.SIYUAN_APPID,
            session,
        }, owner.signal), () => currentDocumentIdentity(protyle), response => {
            applyReplayResponse("redo", protyle, identity, response);
        }, owner.signal);
    } catch (error) {
        if (!owner.signal.aborted) {
            reportRequestError("redo", error);
        }
    } finally {
        owner.release();
    }
};
