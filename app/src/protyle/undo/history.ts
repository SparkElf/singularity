export interface ILocalUndoOperations {
    doOperations: IOperation[];
    undoOperations: IOperation[];
}

export class LocalUndoHistory {
    private redoStack: ILocalUndoOperations[] = [];
    private undoStack: ILocalUndoOperations[] = [];

    constructor(private readonly limit: number) {
    }

    public get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    public get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    public undo(apply: (operations: ILocalUndoOperations) => void): boolean {
        const operations = this.undoStack.pop();
        if (!operations) {
            return false;
        }
        apply(operations);
        this.redoStack.push(operations);
        return true;
    }

    public redo(apply: (operations: ILocalUndoOperations) => void): boolean {
        const operations = this.redoStack.pop();
        if (!operations) {
            return false;
        }
        apply(operations);
        this.undoStack.push(operations);
        return true;
    }

    public add(doOperations: IOperation[], undoOperations: IOperation[]) {
        this.undoStack.push({undoOperations, doOperations});
        if (this.undoStack.length > this.limit) {
            this.undoStack.shift();
        }
        if (this.redoStack.length > 0) {
            this.redoStack = [];
        }
    }

    public clear() {
        this.undoStack = [];
        this.redoStack = [];
    }
}
