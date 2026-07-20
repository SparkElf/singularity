export interface PopoverCapture {
    readonly target: HTMLElement;
    readonly notebookId: string;
}

export class PopoverCaptureState {
    private current?: PopoverCapture;

    public capture(target: HTMLElement, contentNotebookId?: string): PopoverCapture | undefined {
        const isBlockRef = (target.getAttribute("data-type") || "").split(" ").includes("block-ref");
        // 记录弹窗目标的 notebook 归属；显式空属性表示解绑，只有缺少属性时才继承编辑器 owner。
        const notebookId = target.hasAttribute("data-notebook-id")
            ? target.getAttribute("data-notebook-id") || ""
            : (isBlockRef ? "" : contentNotebookId || "");
        if (!notebookId || !target.isConnected) {
            this.current = undefined;
            return;
        }
        this.current = {target, notebookId};
        return this.current;
    }

    public clear() {
        this.current = undefined;
    }

    public get(target?: HTMLElement): PopoverCapture | undefined {
        if (!this.current || !this.current.target.isConnected) {
            this.current = undefined;
            return;
        }
        if (target && this.current.target !== target) {
            return;
        }
        return this.current;
    }
}
