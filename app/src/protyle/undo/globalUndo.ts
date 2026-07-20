import {Constants} from "../../constants";
import {GlobalUndoState, UndoDocumentIdentity} from "./globalUndoState";
import {protyleContentIdentity} from "../util/contentLoad";
import type {ProtyleContentIdentity} from "../../../../enterprise/packages/protyle-browser/src/contracts";

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
    const abort = () => controller.abort();
    if (protyle.requestSignal.aborted) {
        abort();
    } else {
        protyle.requestSignal.addEventListener("abort", abort, {once: true});
    }
    if (!globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
        abort();
    }
    return {
        signal: controller.signal,
        release: () => protyle.requestSignal.removeEventListener("abort", abort),
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
    globalUndoState.sync(notebook, undoState);
};

// 文档打开时主动初始化镜像（低频，不在 selectionchange 热路径）
export const initMirror = async (protyle: IProtyle) => {
    const identity = currentDocumentIdentity(protyle);
    if (!identity) {
        return;
    }
    const contentIdentity = protyleContentIdentity(protyle);
    const initialization = globalUndoState.beginInitialization(identity);
    const owner = createOwnerScope(protyle, identity);
    try {
        const response = await postUndoRequest(protyle, contentIdentity, "/api/transactions/undoState", {
            notebook: identity.notebookId,
            rootID: identity.rootID,
        }, "read", owner.signal);
        const data = response.data;
        if (!owner.signal.aborted &&
            globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
            globalUndoState.applyInitialization(initialization, {
                canUndo: !!data.canUndo,
                canRedo: !!data.canRedo,
            });
        }
    } catch (error) {
        if (!owner.signal.aborted) {
            reportRequestError(protyle, "initialize", error);
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

const postUndoRequest = async (protyle: IProtyle, identity: ProtyleContentIdentity,
                               url: string, data: IObject, intent: "read" | "write",
                               signal: AbortSignal): Promise<IWebSocketData> => {
    const response = await protyle.runtime.transport.request<IWebSocketData>(
        url,
        data,
        {identity, intent, signal},
    );
    if (response.code !== 0) {
        throw new Error(response.msg);
    }
    return response;
};

const reportRequestError = (protyle: IProtyle, action: "initialize" | "undo" | "redo", error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[global-undo] ${action} failed: ${message}`);
    protyle.host.dispatch({type: "notify", level: "error", message});
};

// 解析 rootID 列表为文档名，用于跨文档撤销确认提示
const resolveRootNames = async (protyle: IProtyle, contentIdentity: ProtyleContentIdentity,
                                identity: UndoDocumentIdentity, rootIDs: string[],
                                signal: AbortSignal): Promise<string[]> => {
    const names: string[] = [];
    for (const id of rootIDs) {
        const response = await postUndoRequest(protyle, contentIdentity, "/api/filetree/getHPathByID", {
            id,
            notebook: identity.notebookId,
        }, "read", signal);
        names.push(response.data as string);
    }
    return names;
};

const confirmCrossDocumentUndo = (protyle: IProtyle, names: string[], signal: AbortSignal) => {
    if (signal.aborted) {
        return Promise.resolve(false);
    }
    const text = protyle.localization.text;
    const overlay = document.createElement("div");
    const titleId = `protyle-undo-confirm-${protyle.id}`;
    overlay.className = "b3-dialog b3-dialog--open";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", titleId);

    const scrim = document.createElement("div");
    scrim.className = "b3-dialog__scrim";
    scrim.dataset.action = "cancel";
    const container = document.createElement("div");
    container.className = "b3-dialog__container";
    container.style.width = "min(520px, calc(100vw - 32px))";
    const title = document.createElement("div");
    title.id = titleId;
    title.className = "b3-dialog__header";
    title.textContent = text("undo");
    const body = document.createElement("div");
    body.className = "b3-dialog__body";
    const content = document.createElement("div");
    content.className = "b3-dialog__content ft__breakword";
    const message = document.createElement("div");
    message.textContent = text("undoCrossDocConfirm");
    const list = document.createElement("ul");
    list.style.margin = "8px 0 0";
    names.forEach((name) => {
        const item = document.createElement("li");
        item.textContent = name;
        list.append(item);
    });
    content.append(message, list);

    const actions = document.createElement("div");
    actions.className = "b3-dialog__action";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "b3-button b3-button--cancel";
    cancel.dataset.action = "cancel";
    cancel.textContent = text("cancel");
    const spacer = document.createElement("div");
    spacer.className = "fn__space";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "b3-button b3-button--text";
    confirm.dataset.action = "confirm";
    confirm.textContent = text("confirm");
    actions.append(cancel, spacer, confirm);
    body.append(content, actions);
    container.append(title, body);
    overlay.append(scrim, container);

    const overlays = protyle.runtime.overlays;
    return new Promise<boolean>((resolve, reject) => {
        const handle = overlays.add(overlay);
        let settled = false;
        const cleanup = () => {
            signal.removeEventListener("abort", abort);
            overlay.removeEventListener("click", click);
            overlay.removeEventListener("keydown", keydown);
        };
        const settle = (confirmed: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            handle.close();
            resolve(confirmed);
        };
        const abort = () => settle(false);
        const click = (event: MouseEvent) => {
            const action = (event.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
            if (action === "confirm") {
                settle(true);
            } else if (action === "cancel") {
                settle(false);
            }
        };
        const keydown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.repeat) {
                event.preventDefault();
                event.stopPropagation();
                settle(false);
            }
        };
        signal.addEventListener("abort", abort, {once: true});
        overlay.addEventListener("click", click);
        overlay.addEventListener("keydown", keydown);
        try {
            protyle.element.append(overlay);
            overlays.bringToFront(overlay);
        } catch (error) {
            settled = true;
            cleanup();
            handle.close();
            reject(error);
            return;
        }
        if (signal.aborted) {
            settle(false);
        } else {
            confirm.focus();
        }
    });
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
        console.warn(`[global-undo] ${action} rejected: ${data.msg}`);
        protyle.host.dispatch({type: "notify", level: "error", message: data.msg});
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
    const mutatedRootIDs: string[] = data.mutatedRootIDs;
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
    const identity = currentDocumentIdentity(protyle);
    if (!identity) {
        return;
    }

    const state = globalUndoState.get(identity);
    if (!state.canUndo) {
        return; // 语义 B：栈空不做事
    }
    const contentIdentity = protyleContentIdentity(protyle);
    const session = protyle.id;
    const owner = createOwnerScope(protyle, identity);
    try {
        await globalUndoState.runRequest(identity, async () => {
            const stateResponse = await postUndoRequest(protyle, contentIdentity,
                "/api/transactions/undoState", {
                notebook: identity.notebookId,
                rootID: identity.rootID,
            }, "read", owner.signal);
            const peekMutatedRootIDs: string[] = stateResponse.data.peekMutatedRootIDs;
            if (!globalUndoState.isCurrent(identity, currentDocumentIdentity(protyle))) {
                return;
            }
            if (peekMutatedRootIDs.length > 1) {
                const names = await resolveRootNames(
                    protyle,
                    contentIdentity,
                    identity,
                    peekMutatedRootIDs,
                    owner.signal,
                );
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
                    confirmed = await confirmCrossDocumentUndo(protyle, names, owner.signal);
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
            return postUndoRequest(protyle, contentIdentity, "/api/transactions/undo", {
                notebook: identity.notebookId,
                rootID: identity.rootID,
                app: Constants.SIYUAN_APPID,
                session,
            }, "write", owner.signal);
        }, () => currentDocumentIdentity(protyle), response => {
            applyReplayResponse("undo", protyle, identity, response);
        }, owner.signal);
    } catch (error) {
        if (!owner.signal.aborted) {
            reportRequestError(protyle, "undo", error);
        }
    } finally {
        owner.release();
    }
};

// 请求重做：对称，redo 不提示（其逆已在 undo 中确认）
export const requestRedo = async (protyle: IProtyle) => {
    const identity = currentDocumentIdentity(protyle);
    if (!identity) {
        return;
    }

    const state = globalUndoState.get(identity);
    if (!state.canRedo) {
        return;
    }
    const contentIdentity = protyleContentIdentity(protyle);
    const session = protyle.id;
    const owner = createOwnerScope(protyle, identity);
    try {
        // As with undo, aborting the response wait cannot roll back a kernel mutation that was already admitted.
        await globalUndoState.runRequest(identity, () => postUndoRequest(
            protyle,
            contentIdentity,
            "/api/transactions/redo",
            {
                notebook: identity.notebookId,
                rootID: identity.rootID,
                app: Constants.SIYUAN_APPID,
                session,
            },
            "write",
            owner.signal,
        ), () => currentDocumentIdentity(protyle), response => {
            applyReplayResponse("redo", protyle, identity, response);
        }, owner.signal);
    } catch (error) {
        if (!owner.signal.aborted) {
            reportRequestError(protyle, "redo", error);
        }
    } finally {
        owner.release();
    }
};
