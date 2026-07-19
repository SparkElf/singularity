import {App} from "../index";
import {Protyle} from "./index";
import {OwnerGeneration, OwnerLifecycle} from "./runtime/ownerLifecycle";

export interface EmbeddedProtyleBinding extends OwnerGeneration {
    readonly protyle: IProtyle;
}

export class EmbeddedProtyleOwner {
    public readonly app: App;
    public readonly element: HTMLElement;
    private readonly ownerOptions: Omit<IProtyleOptions, "blockId" | "notebookId">;
    private readonly hostReadOnly: boolean;
    private readonly lifecycle = new OwnerLifecycle();
    private editor?: Protyle;

    constructor(app: App, element: HTMLElement,
                options: Omit<IProtyleOptions, "blockId" | "notebookId">,
                hostReadOnly: boolean) {
        this.app = app;
        this.element = element;
        this.ownerOptions = options;
        this.hostReadOnly = hostReadOnly;
    }

    public get signal(): AbortSignal {
        return this.lifecycle.signal;
    }

    public bind(notebookId: string, blockId: string): EmbeddedProtyleBinding {
        if (this.lifecycle.ended) {
            throw new Error("[protyle.legacy] destroyed embedded owner cannot bind a target");
        }
        if (!notebookId || !blockId) {
            throw new Error("[protyle.content] embedded preview requires notebookId and blockId");
        }
        const ownerGeneration = this.lifecycle.begin();
        if (this.editor?.protyle.notebookId === notebookId && this.editor.protyle.options.blockId === blockId) {
            return {
                ...ownerGeneration,
                protyle: this.editor.protyle,
            };
        }
        const style = this.element.getAttribute("style");
        this.releaseEditor();
        const editor = new Protyle(this.app, this.element, {
            ...this.ownerOptions,
            blockId,
        }, {
            surface: "embedded",
            participation: "live",
            content: {mode: "bound", notebookId},
            initialLoad: "owner",
            hostReadOnly: this.hostReadOnly,
            onContentUnavailable: () => this.clear(),
        });
        if (style !== null) {
            editor.protyle.element.setAttribute("style", style);
        }
        this.editor = editor;
        return {
            ...ownerGeneration,
            protyle: editor.protyle,
        };
    }

    public invalidate(): OwnerGeneration {
        return this.lifecycle.begin();
    }

    public isCurrent(binding: EmbeddedProtyleBinding): boolean {
        return this.lifecycle.isCurrent(binding, this.element.isConnected) &&
            this.editor?.protyle === binding.protyle && !binding.protyle.destroyed;
    }

    public isCurrentGeneration(ownerGeneration: OwnerGeneration, mountedElement: Element = this.element): boolean {
        return this.lifecycle.isCurrent(ownerGeneration, mountedElement.isConnected);
    }

    public addCleanup(cleanup: () => void): () => void {
        return this.lifecycle.addCleanup(cleanup);
    }

    public get protyle(): IProtyle | undefined {
        return this.editor?.protyle;
    }

    public getCurrent(): Protyle | undefined {
        return this.editor;
    }

    public clear() {
        if (this.lifecycle.ended) {
            return;
        }
        this.lifecycle.begin();
        const style = this.element.getAttribute("style");
        this.releaseEditor();
        if (style !== null) {
            this.element.setAttribute("style", style);
        }
    }

    public destroy() {
        if (this.lifecycle.ended) {
            return;
        }
        this.lifecycle.destroy();
        this.releaseEditor();
    }

    public resize() {
        this.editor?.resize();
    }

    private releaseEditor() {
        const editor = this.editor;
        this.editor = undefined;
        editor?.destroy();
    }
}
