export class ConfirmDialogLifecycle<T> {
    private settled = false;

    constructor(private readonly onConfirm?: (context?: T) => void,
                private readonly onCancel?: (context: T) => void) {
    }

    public confirm(context: T): boolean {
        return this.settle(true, context);
    }

    public cancel(context: T): boolean {
        return this.settle(false, context);
    }

    private settle(confirmed: boolean, context: T): boolean {
        if (this.settled) {
            return false;
        }
        this.settled = true;
        if (confirmed) {
            this.onConfirm?.(context);
        } else {
            this.onCancel?.(context);
        }
        return true;
    }
}
