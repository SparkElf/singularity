import {onTransaction, transaction} from "../wysiwyg/transaction";
import {preventScroll} from "../scroll/preventScroll";
import {Constants} from "../../constants";
import {hideElements} from "../ui/hideElements";
import {markMirror, refreshUndoButtons, requestRedo, requestUndo} from "./globalUndo";
import {scrollCenter} from "../../util/highlightById";
import {ILocalUndoOperations, LocalUndoHistory} from "./history";

// 撤销/重做统一契约：kernel 模式由 Undo 实现（转发 kernel），lite 模式由 LocalUndo 实现（前端操作日志）。
export interface IUndo {
    undo(protyle: IProtyle): void;

    redo(protyle: IProtyle): void;

    add(doOperations: IOperation[], undoOperations: IOperation[], protyle: IProtyle): void;

    clear(): void;

    // kernel 模式独有：发起窗口本地乐观应用操作（lite 模式的 LocalUndo 不需要）。
    renderLocal?(protyle: IProtyle, operations: IOperation[]): void;
}

// 撤销权威栈已下沉到 kernel（GlobalUndoLog），前端按 rootID 共享。
// 本类仅保留发起窗口本地乐观应用的渲染逻辑（renderLocal，走 isUndo=true 分支，
// 保住光标恢复/折叠/zoom 兜底），以及按钮态刷新。
export class Undo implements IUndo {
    public undo(protyle: IProtyle) {
        if (protyle.disabled) {
            return;
        }
        // 转发到全局 Manager，由 kernel 弹栈 + 广播，发起窗口本地乐观应用
        requestUndo(protyle);
    }

    public redo(protyle: IProtyle) {
        if (protyle.disabled) {
            return;
        }
        requestRedo(protyle);
    }

    // renderLocal 仅在发起窗口本地应用操作（isUndo=true），不 POST 到 kernel
    // （kernel 的 undo/redo 接口已执行事务并广播）。保留光标恢复/折叠/zoom/lastHTMLs 行为。
    public renderLocal(protyle: IProtyle, operations: IOperation[]) {
        hideElements(["hint", "gutter"], protyle);
        protyle.wysiwyg.lastHTMLs = {};
        for (let i = operations.length - 1; i >= 0; i--) {
            if (operations[i].action === "insert") {
                if (operations[i].context) {
                    operations[i].context.setRange = "true";
                } else {
                    operations[i].context = {setRange: "true"};

                }
                break;
            }
        }
        onTransaction(protyle, operations, true);
        document.querySelector(".av__panel")?.remove();
        preventScroll(protyle);
        // 同步 toolbar range，避免 undo/redo 替换 DOM 后 range 变为 detached，
        // 导致后续异步操作（如 F3 创建子文档）读到无效 range 而报错 https://github.com/siyuan-note/siyuan/issues/17896
        if (getSelection().rangeCount > 0) {
            protyle.toolbar.range = getSelection().getRangeAt(0);
        }
    }

    // add 降级为：不压栈（kernel 已在 commit 后 Record），仅置位本地镜像 + 刷新按钮态。
    // 保留签名以兼容 transaction.ts 的调用点。
    public add(doOperations: IOperation[], undoOperations: IOperation[], protyle: IProtyle) {
        if (protyle.block?.rootID) {
            markMirror(protyle.block.rootID, {canUndo: true});
        }
        refreshUndoButtons(protyle);
    }

    public clear() {
        // kernel 全局栈不随前端编辑器销毁/重载而清空（跨窗口共享）。
        // 本地仅刷新按钮态，镜像条目保留供重开校准。
    }
}

// lite 模式的前端撤销：不落盘、无 rootID，无法用 kernel 的 GlobalUndoLog，
// 故在前端以 IOperation 操作日志维护撤销/重做。回放时用 onTransaction(ops, true) 本地应用 DOM。
export class LocalUndo implements IUndo {
    private readonly history = new LocalUndoHistory(Constants.SIZE_UNDO);

    public undo(protyle: IProtyle) {
        if (protyle.disabled) {
            return;
        }
        if (!this.history.undo((state) => this.render(protyle, state, false))) {
            return;
        }
        if (protyle.breadcrumb) {
            const undoElement = protyle.breadcrumb.element.parentElement.querySelector('[data-type="undo"]');
            if (undoElement) {
                if (!this.history.canUndo) {
                    undoElement.setAttribute("disabled", "true");
                }
                protyle.breadcrumb.element.parentElement.querySelector('[data-type="redo"]').removeAttribute("disabled");
            }
        }
    }

    public redo(protyle: IProtyle) {
        if (protyle.disabled) {
            return;
        }
        if (!this.history.redo((state) => this.render(protyle, state, true))) {
            return;
        }
        if (protyle.breadcrumb) {
            const redoElement = protyle.breadcrumb.element.parentElement.querySelector('[data-type="redo"]');
            if (redoElement) {
                protyle.breadcrumb.element.parentElement.querySelector('[data-type="undo"]').removeAttribute("disabled");
                if (!this.history.canRedo) {
                    redoElement.setAttribute("disabled", "true");
                }
            }
        }
    }

    private render(protyle: IProtyle, state: ILocalUndoOperations, redo: boolean) {
        hideElements(["hint", "gutter"], protyle);
        protyle.wysiwyg.lastHTMLs = {};
        if (!redo) {
            for (let i = state.undoOperations.length - 1; i >= 0; i--) {
                if (state.undoOperations[i].action === "insert") {
                    if (state.undoOperations[i].context) {
                        state.undoOperations[i].context.setRange = "true";
                    } else {
                        state.undoOperations[i].context = {setRange: "true"};
                    }
                    break;
                }
            }
            onTransaction(protyle, state.undoOperations, true);
            transaction(protyle, state.undoOperations, undefined, {skipSync: true});
        } else {
            for (let i = state.doOperations.length - 1; i >= 0; i--) {
                if (state.doOperations[i].action === "insert") {
                    if (state.doOperations[i].context) {
                        state.doOperations[i].context.setRange = "true";
                    } else {
                        state.doOperations[i].context = {setRange: "true"};
                    }
                    break;
                }
            }
            onTransaction(protyle, state.doOperations, true);
            transaction(protyle, state.doOperations, undefined, {skipSync: true});
        }
        document.querySelector(".av__panel")?.remove();
        preventScroll(protyle);
        scrollCenter(protyle);
    }

    public add(doOperations: IOperation[], undoOperations: IOperation[], protyle: IProtyle) {
        this.history.add(doOperations, undoOperations);
        if (protyle.breadcrumb) {
            const undoElement = protyle.breadcrumb.element.parentElement.querySelector('[data-type="undo"]');
            if (undoElement) {
                undoElement.removeAttribute("disabled");
            }
        }
    }

    public clear() {
        this.history.clear();
    }
}
