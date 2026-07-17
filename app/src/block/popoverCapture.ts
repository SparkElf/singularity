export interface PopoverCapture {
    readonly target: HTMLElement;
    readonly notebookId: string;
}

export class PopoverCaptureState {
    private current?: PopoverCapture;

    public capture(target: HTMLElement, contentNotebookId?: string): PopoverCapture | undefined {
        const notebookId = target.hasAttribute("data-notebook-id")
            ? target.getAttribute("data-notebook-id") || ""
            : contentNotebookId || "";
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
