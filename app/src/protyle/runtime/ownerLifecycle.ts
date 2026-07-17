export interface OwnerGeneration {
    readonly generation: number;
    readonly signal: AbortSignal;
}

export class OwnerLifecycle {
    private readonly terminalController = new AbortController();
    private generationController = new AbortController();
    private generation = 0;

    public get signal(): AbortSignal {
        return this.terminalController.signal;
    }

    public get ended(): boolean {
        return this.signal.aborted;
    }

    public begin(): OwnerGeneration {
        if (this.ended) {
            throw new Error("[protyle.lifecycle] terminated owner cannot begin work");
        }
        this.generationController.abort();
        this.generationController = new AbortController();
        return {
            generation: ++this.generation,
            signal: this.generationController.signal,
        };
    }

    public isCurrent(ownerGeneration: OwnerGeneration, mounted: boolean): boolean {
        return mounted && !this.ended && !ownerGeneration.signal.aborted &&
            ownerGeneration.generation === this.generation;
    }

    public addCleanup(cleanup: () => void): () => void {
        if (this.ended) {
            throw new Error("[protyle.lifecycle] terminated owner cannot acquire resources");
        }
        this.signal.addEventListener("abort", cleanup, {once: true});
        return () => this.signal.removeEventListener("abort", cleanup);
    }

    public destroy() {
        if (this.ended) {
            return;
        }
        this.terminalController.abort();
        this.generationController.abort();
        this.generation++;
    }
}
