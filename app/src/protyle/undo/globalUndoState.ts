export interface UndoDocumentIdentity {
    readonly notebookId: string;
    readonly rootID: string;
}

export interface UndoStateMirror {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
}

export interface UndoMirrorInitialization {
    readonly identity: UndoDocumentIdentity;
    readonly generation: number;
    readonly version: number;
}

export type UndoRequestResult = "applied" | "busy" | "cancelled" | "stale";

interface UndoMirrorEntry {
    state: UndoStateMirror;
    version: number;
    initializationGeneration: number;
}

const REQUEST_CANCELLED = Symbol("global undo request cancelled");

export class GlobalUndoState {
    private readonly mirrors = new Map<string, Map<string, UndoMirrorEntry>>();
    private requestInFlight = false;

    public mark(identity: UndoDocumentIdentity, state: Partial<UndoStateMirror>) {
        const entry = this.getEntry(identity);
        entry.state = {...entry.state, ...state};
        entry.version++;
    }

    public get(identity: UndoDocumentIdentity): UndoStateMirror {
        return this.mirrors.get(identity.notebookId)?.get(identity.rootID)?.state ||
            {canUndo: false, canRedo: false};
    }

    public beginInitialization(identity: UndoDocumentIdentity): UndoMirrorInitialization {
        const entry = this.getEntry(identity);
        return {
            identity,
            generation: ++entry.initializationGeneration,
            version: entry.version,
        };
    }

    public applyInitialization(initialization: UndoMirrorInitialization, state: UndoStateMirror): boolean {
        const entry = this.getEntry(initialization.identity);
        if (entry.initializationGeneration !== initialization.generation || entry.version !== initialization.version) {
            return false;
        }
        entry.state = state;
        entry.version++;
        return true;
    }

    public sync(notebookId: string,
                states: Record<string, { canUndo: boolean; canRedo: boolean }>) {
        Object.entries(states).forEach(([rootID, state]) => {
            this.mark({notebookId, rootID}, {canUndo: !!state.canUndo, canRedo: !!state.canRedo});
        });
    }

    public isCurrent(expected: UndoDocumentIdentity, current?: UndoDocumentIdentity) {
        return !!current && expected.notebookId === current.notebookId && expected.rootID === current.rootID;
    }

    public async runRequest<T>(identity: UndoDocumentIdentity,
                               request: () => Promise<T>,
                               currentIdentity: () => UndoDocumentIdentity | undefined,
                               commit: (value: T) => void,
                               signal?: AbortSignal): Promise<UndoRequestResult> {
        if (this.requestInFlight) {
            return "busy";
        }
        if (signal?.aborted) {
            return "cancelled";
        }
        this.requestInFlight = true;
        try {
            const value = await this.waitForOwner(request(), signal);
            if (value === REQUEST_CANCELLED) {
                return "cancelled";
            }
            if (!this.isCurrent(identity, currentIdentity())) {
                return "stale";
            }
            commit(value);
            return "applied";
        } finally {
            this.requestInFlight = false;
        }
    }

    private getEntry(identity: UndoDocumentIdentity): UndoMirrorEntry {
        let notebookMirrors = this.mirrors.get(identity.notebookId);
        if (!notebookMirrors) {
            notebookMirrors = new Map<string, UndoMirrorEntry>();
            this.mirrors.set(identity.notebookId, notebookMirrors);
        }
        let entry = notebookMirrors.get(identity.rootID);
        if (!entry) {
            entry = {
                state: {canUndo: false, canRedo: false},
                version: 0,
                initializationGeneration: 0,
            };
            notebookMirrors.set(identity.rootID, entry);
        }
        return entry;
    }

    private waitForOwner<T>(request: Promise<T>, signal?: AbortSignal): Promise<T | typeof REQUEST_CANCELLED> {
        if (!signal) {
            return request;
        }
        if (signal.aborted) {
            return Promise.resolve(REQUEST_CANCELLED);
        }
        return new Promise<T | typeof REQUEST_CANCELLED>((resolve, reject) => {
            const settleCancelled = () => {
                signal.removeEventListener("abort", settleCancelled);
                resolve(REQUEST_CANCELLED);
            };
            signal.addEventListener("abort", settleCancelled, {once: true});
            request.then((value) => {
                signal.removeEventListener("abort", settleCancelled);
                resolve(value);
            }, (error) => {
                signal.removeEventListener("abort", settleCancelled);
                reject(error);
            });
        });
    }
}
