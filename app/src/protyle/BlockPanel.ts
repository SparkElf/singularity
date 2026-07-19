import type {ProtyleOverlayHandle} from "../../../enterprise/packages/protyle-browser/src/contracts";
import {Constants} from "../constants";
import {Protyle} from "./index";
import {hideElements} from "./ui/hideElements";
import {positionElementInViewport} from "./ui/positionElement";
import {beginProtyleContentLoad, requestProtyleContent} from "./util/contentLoad";
import {updateHotkeyAfterTip} from "./util/keyboard";
import {onGet} from "./util/onGet";
import {initMirror} from "./undo/globalUndo";

const BLOCK_PANEL_ATTRIBUTE = "protyleBlockPanel";
const BLOCK_PANEL_SELECTOR = '[data-protyle-block-panel="true"]';
const BLOCK_PANEL_CLOSE_EVENT = "protyle:block-panel-close";
const MIN_PANEL_WIDTH = 200;
const MIN_PANEL_HEIGHT = 160;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const RESIZE_DIRECTIONS = ["rd", "ld", "lt", "rt", "r", "d", "t", "l"] as const;

type ResizeDirection = typeof RESIZE_DIRECTIONS[number];

export interface BlockPanelReference {
    readonly blockId: string;
    readonly notebookId: string;
    readonly documentId: string;
    readonly definitionIds?: readonly string[];
}

export interface OpenBlockPanelOptions {
    readonly sourceProtyle: IProtyle;
    readonly references: readonly BlockPanelReference[];
    readonly targetElement?: HTMLElement;
    readonly position?: {
        readonly x: number;
        readonly y: number;
    };
    readonly isBacklink: boolean;
    readonly originalRefBlockIDs?: IObject;
}

export interface BlockPanelHandle {
    readonly element: HTMLElement;
    readonly sourceEditorId: string;
    close(): void;
    bringToFront(): void;
}

export const closeContainingBlockPanel = (element: Element): boolean => {
    const panel = element.closest<HTMLElement>(BLOCK_PANEL_SELECTOR);
    if (!panel) {
        return false;
    }
    panel.dispatchEvent(new Event(BLOCK_PANEL_CLOSE_EVENT));
    return true;
};

const createSpacer = (grow = false) => {
    const spacer = document.createElement("span");
    spacer.className = grow ? "fn__space fn__flex-1" : "fn__space";
    return spacer;
};

const createIconButton = (type: string, label: string, icon: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "block__icon block__icon--show b3-tooltips b3-tooltips__sw";
    button.dataset.type = type;
    button.setAttribute("aria-label", label);

    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    const use = document.createElementNS(SVG_NAMESPACE, "use");
    use.setAttribute("href", `#${icon}`);
    svg.append(use);
    button.append(svg);
    return button;
};

const setButtonIcon = (button: HTMLElement, icon: string) => {
    button.querySelector("use")!.setAttribute("href", `#${icon}`);
};

const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum);

class BlockPanelOwner implements BlockPanelHandle {
    public readonly element: HTMLElement;
    public readonly sourceEditorId: string;

    private readonly sourceProtyle: IProtyle;
    private readonly references: readonly BlockPanelReference[];
    private readonly targetElement?: HTMLElement;
    private readonly position?: OpenBlockPanelOptions["position"];
    private readonly isBacklink: boolean;
    private readonly originalRefBlockIDs?: IObject;
    private readonly runtime: TProtyleRuntime;
    private readonly ownerController = new AbortController();
    private readonly overlayHandle: ProtyleOverlayHandle;
    private readonly editors: Protyle[] = [];
    private readonly startedEditorElements = new Set<HTMLElement>();
    private resizeObserver?: ResizeObserver;
    private loadObserver?: IntersectionObserver;
    private resizeTimer?: number;
    private targetCursor?: string;
    private targetCursorActive = false;
    private closed = false;

    constructor(options: OpenBlockPanelOptions) {
        this.sourceProtyle = options.sourceProtyle;
        this.sourceEditorId = options.sourceProtyle.id;
        this.references = options.references;
        this.targetElement = options.targetElement;
        this.position = options.position;
        this.isBacklink = options.isBacklink;
        this.originalRefBlockIDs = options.originalRefBlockIDs;
        this.runtime = this.sourceProtyle.session!.runtime;

        this.element = document.createElement("div");
        this.element.className = "block__popover";
        this.element.dataset[BLOCK_PANEL_ATTRIBUTE] = "true";
        this.element.dataset.pin = "false";
        this.configureHierarchy();
        const editorElements = this.render();

        const overlays = this.runtime.overlays;
        this.overlayHandle = overlays.add(this.element, this.close);
        try {
            document.body.append(this.element);
            this.bindEvents();
            overlays.bringToFront(this.element);

            this.sourceProtyle.requestSignal.addEventListener("abort", this.close, {once: true});
            if (this.sourceProtyle.requestSignal.aborted) {
                this.close();
                return;
            }

            this.setTargetCursorWaiting();
            this.startEditorLoading(editorElements);
        } catch (error) {
            this.close();
            throw error;
        } finally {
            this.restoreTargetCursor();
        }
    }

    public close = () => {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.ownerController.abort();
        this.resizeObserver?.disconnect();
        this.loadObserver?.disconnect();
        if (this.resizeTimer !== undefined) {
            window.clearTimeout(this.resizeTimer);
        }
        this.element.style.userSelect = "";
        this.editors.splice(0).forEach((editor) => {
            hideElements(["util"], editor.protyle);
            editor.destroy();
        });
        this.startedEditorElements.clear();
        this.sourceProtyle.requestSignal.removeEventListener("abort", this.close);
        this.restoreTargetCursor();
        this.overlayHandle.close();
    };

    public bringToFront = () => {
        if (!this.closed && this.element.isConnected) {
            this.runtime.overlays.bringToFront(this.element);
        }
    };

    private configureHierarchy() {
        const parentPanel = this.targetElement?.closest<HTMLElement>(
            BLOCK_PANEL_SELECTOR,
        );
        const level = parentPanel ? Number(parentPanel.dataset.level) + 1 : 1;
        this.element.dataset.level = String(level);
        const ownerId = parentPanel?.dataset.oid ?? this.references[0]?.blockId;
        if (ownerId) {
            this.element.dataset.oid = ownerId;
        }

        this.runtime.overlays.forEach((overlay) => {
            if (overlay.dataset[BLOCK_PANEL_ATTRIBUTE] === "true" &&
                overlay.dataset.pin === "false" && Number(overlay.dataset.level) >= level) {
                overlay.dispatchEvent(new Event(BLOCK_PANEL_CLOSE_EVENT));
            }
        });
    }

    private render() {
        const localization = this.sourceProtyle.localization;
        const icons = document.createElement("div");
        icons.className = "block__icons block__icons--menu";
        const moveHandle = createSpacer(true);
        moveHandle.classList.add("resize__move");
        icons.append(moveHandle);

        if (this.references.length === 1) {
            const openLabel = localization.text("openInNewTab") + updateHotkeyAfterTip(
                this.sourceProtyle.settings.hotkeys.editor.general.openInNewTab,
            );
            const openButton = createIconButton("stickTab", openLabel, "iconOpen");
            openButton.disabled = true;
            icons.append(openButton, createSpacer());
        }
        icons.append(
            createIconButton("pin", localization.text("pin"), "iconPin"),
            createSpacer(),
            createIconButton("close", localization.text("close"), "iconClose"),
        );

        const content = document.createElement("div");
        content.className = "block__content";
        const editorElements: HTMLElement[] = [];
        if (this.references.length === 0) {
            const expired = document.createElement("div");
            expired.className = "ft__smaller ft__secondary b3-form__space--small";
            expired.contentEditable = "false";
            expired.textContent = localization.text("refExpired");
            content.append(expired);
        } else {
            this.references.forEach((_reference, index) => {
                const editorElement = document.createElement("div");
                editorElement.className = "block__edit fn__flex-1 protyle";
                editorElement.dataset.index = String(index);
                editorElements.push(editorElement);
                content.append(editorElement);
            });
        }

        this.element.append(icons, content);
        RESIZE_DIRECTIONS.forEach((direction) => {
            const handle = document.createElement("div");
            handle.className = `resize__${direction}`;
            this.element.append(handle);
        });
        return editorElements;
    }

    private bindEvents() {
        const signal = this.ownerController.signal;
        this.element.addEventListener(BLOCK_PANEL_CLOSE_EVENT, this.close, {signal});
        this.element.addEventListener("click", (event) => {
            this.bringToFront();
            if (!(event.target instanceof Element)) {
                return;
            }
            const control = event.target.closest<HTMLElement>("[data-type]");
            if (!control || !this.element.contains(control)) {
                return;
            }
            if (control.dataset.type === "close") {
                this.close();
            } else if (control.dataset.type === "pin") {
                this.setPinned(this.element.dataset.pin !== "true");
            } else if (control.dataset.type === "stickTab") {
                this.openFirstReference();
            } else {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
        }, {signal});
        this.element.addEventListener("dblclick", (event) => {
            if (event.target instanceof Element && event.target.closest(".resize__move")) {
                this.setPinned(this.element.dataset.pin !== "true");
                event.preventDefault();
                event.stopPropagation();
            }
        }, {signal});
        this.element.addEventListener("pointerdown", this.startMoveResize, {signal});
        this.element.querySelector(".block__content")!.addEventListener("scroll", () => {
            this.editors.forEach((editor) => hideElements(["gutter"], editor.protyle));
        }, {signal});
    }

    private setPinned(pinned: boolean) {
        this.element.dataset.pin = String(pinned);
        const pinButton = this.element.querySelector<HTMLElement>('[data-type="pin"]')!;
        pinButton.setAttribute("aria-label", this.sourceProtyle.localization.text(pinned ? "unpin" : "pin"));
        setButtonIcon(pinButton, pinned ? "iconUnpin" : "iconPin");
    }

    private openFirstReference() {
        const reference = this.references[0]!;
        this.sourceProtyle.host.dispatch({
            type: "open-document",
            notebookId: reference.notebookId,
            documentId: reference.documentId,
            blockId: reference.blockId,
            disposition: "new-tab",
            scope: reference.documentId === reference.blockId ? "target" : "context",
            attention: "focus",
            scroll: "start",
            restoreScroll: "never",
            zoom: false,
        });
        this.close();
    }

    private startEditorLoading(editorElements: readonly HTMLElement[]) {
        this.resizeObserver = new ResizeObserver(() => {
            if (this.resizeTimer !== undefined) {
                window.clearTimeout(this.resizeTimer);
            }
            this.resizeTimer = window.setTimeout(() => {
                this.editors.forEach((editor) => editor.resize());
            }, Constants.TIMEOUT_TRANSITION);
        });
        this.resizeObserver.observe(this.element);

        this.loadObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    const editorElement = entry.target as HTMLElement;
                    this.initEditor(editorElement, Number(editorElement.dataset.index));
                }
            });
        }, {threshold: 0});

        editorElements.forEach((editorElement, index) => {
            if (index < 5) {
                this.initEditor(editorElement, index);
            } else {
                this.loadObserver!.observe(editorElement);
            }
        });
        if (editorElements.length === 0) {
            this.showPanel();
        }
    }

    private initEditor(editorElement: HTMLElement, index: number) {
        if (this.startedEditorElements.has(editorElement)) {
            return;
        }
        this.startedEditorElements.add(editorElement);
        this.loadObserver?.unobserve(editorElement);
        const reference = this.references[index];
        const targetIsDocument = reference.documentId === reference.blockId;
        const action: TProtyleAction[] = [
            targetIsDocument ? Constants.CB_GET_CONTEXT : Constants.CB_GET_ALL,
        ];
        if (this.isBacklink) {
            action.push(Constants.CB_GET_BACKLINK);
        }

        let editor: Protyle;
        try {
            editor = new Protyle(this.sourceProtyle.application, editorElement, {
                blockId: reference.documentId,
                defIds: [...(reference.definitionIds ?? [])],
                originalRefBlockIDs: this.isBacklink ? this.originalRefBlockIDs : undefined,
                action,
                render: {
                    scroll: true,
                    gutter: true,
                    breadcrumbDocName: true,
                    title: targetIsDocument,
                },
                typewriterMode: false,
            }, {
                surface: "embedded",
                participation: "live",
                content: {mode: "bound", notebookId: reference.notebookId},
                initialLoad: "owner",
                session: this.sourceProtyle.session!,
                hostReadOnly: this.sourceProtyle.readonlyState.host,
                signal: this.ownerController.signal,
            });
        } catch (error) {
            this.reportLoadFailure(error, reference);
            if (index === 0) {
                this.showPanel();
            }
            return;
        }

        this.editors.push(editor);
        if (index === 0) {
            const openButton = this.element.querySelector<HTMLButtonElement>('[data-type="stickTab"]');
            if (openButton) {
                openButton.disabled = false;
            }
            this.showPanel();
        }

        const load = beginProtyleContentLoad(editor.protyle, this.ownerController.signal);
        void requestProtyleContent<IWebSocketData>(editor.protyle, "/api/filetree/getDoc", {
            id: reference.blockId,
            isBacklink: this.isBacklink,
            originalRefBlockIDs: this.isBacklink ? this.originalRefBlockIDs : undefined,
            mode: targetIsDocument ? 3 : 0,
            size: targetIsDocument
                ? this.sourceProtyle.settings.editor.dynamicLoadBlocks
                : Constants.SIZE_GET_MAX,
        }, load).then((response) => {
            if (!load.isCurrent() || this.closed || !editorElement.isConnected) {
                return;
            }
            onGet({
                data: response,
                protyle: editor.protyle,
                action,
                load,
                afterCB: () => {
                    if (!load.isCurrent() || this.closed || !editorElement.isConnected) {
                        return;
                    }
                    if (!targetIsDocument) {
                        editor.protyle.breadcrumb?.element.parentElement?.lastElementChild?.classList.remove("fn__none");
                    }
                    void initMirror(editor.protyle);
                    editor.resize();
                    this.sizeLoadedEditor(editor);
                    editor.protyle.contentElement.classList.add("protyle-content--transition");
                },
            });
        }).catch((error: unknown) => {
            if (load.isCurrent() && !this.closed && editorElement.isConnected) {
                this.reportLoadFailure(error, reference);
            }
        });
    }

    private reportLoadFailure(error: unknown, reference: BlockPanelReference) {
        if (this.ownerController.signal.aborted) {
            return;
        }
        console.error("[protyle.block-panel] content load failed", {
            blockId: reference.blockId,
            documentId: reference.documentId,
            notebookId: reference.notebookId,
            error,
        });
        this.sourceProtyle.host.dispatch({
            type: "notify",
            level: "error",
            message: error instanceof Error ? error.message : String(error),
        });
    }

    private sizeLoadedEditor(editor: Protyle) {
        if (editor.protyle.element.nextElementSibling || editor.protyle.element.previousElementSibling) {
            editor.protyle.element.style.minHeight =
                `${Math.min(30 + editor.protyle.wysiwyg.element.clientHeight, window.innerHeight / 3)}px`;
        }
        editor.protyle.scroll?.element.parentElement?.style.setProperty(
            "--b3-dynamicscroll-width",
            `${Math.min(editor.protyle.contentElement.clientHeight - 49, 200)}px`,
        );
    }

    private showPanel() {
        if (this.closed || !this.element.isConnected) {
            return;
        }
        this.positionPanel();
        this.element.classList.add("block__popover--open");
        this.bringToFront();
    }

    private positionPanel() {
        const viewportHeight = document.documentElement.clientHeight;
        if (this.targetElement?.classList.contains("protyle-wysiwyg__embed")) {
            const targetRect = this.targetElement.getBoundingClientRect();
            const contentTop = this.targetElement.closest(".protyle-content")?.getBoundingClientRect().top;
            const targetTop = contentTop === undefined ? targetRect.top : Math.max(targetRect.top, contentTop);
            this.element.style.height = `${Math.min(viewportHeight - targetTop, targetRect.height + 42)}px`;
            positionElementInViewport(this.element, targetRect.left, Math.max(0, targetTop - 42));
            return;
        }

        if (this.targetElement) {
            const positionTarget = this.targetElement.classList.contains("pdf__rect")
                ? this.targetElement.firstElementChild as HTMLElement
                : this.targetElement;
            const targetRect = positionTarget.getBoundingClientRect();
            const panelRect = this.element.getBoundingClientRect();
            const belowTop = targetRect.bottom + 4;
            const top = belowTop + panelRect.height <= viewportHeight
                ? belowTop
                : targetRect.top - panelRect.height - 8;
            positionElementInViewport(this.element, targetRect.left, top);
            const positionedTop = this.element.getBoundingClientRect().top;
            const availableHeight = positionedTop < targetRect.top
                ? targetRect.top - positionedTop - 8
                : viewportHeight - positionedTop - 8;
            this.element.style.maxHeight = `${Math.max(0, Math.floor(availableHeight))}px`;
            return;
        }

        const x = this.position?.x ?? 0;
        const y = this.position?.y ?? 0;
        this.element.style.maxHeight = `${Math.floor(viewportHeight - Math.max(0, y) - 12)}px`;
        positionElementInViewport(this.element, x, y);
    }

    private setTargetCursorWaiting() {
        if (!this.targetElement) {
            return;
        }
        this.targetCursor = this.targetElement.style.cursor;
        this.targetCursorActive = true;
        this.targetElement.style.cursor = "wait";
    }

    private restoreTargetCursor() {
        if (!this.targetElement || !this.targetCursorActive) {
            return;
        }
        this.targetElement.style.cursor = this.targetCursor ?? "";
        this.targetCursorActive = false;
    }

    private startMoveResize = (event: PointerEvent) => {
        if (event.button !== 0 || !(event.target instanceof Element)) {
            return;
        }
        const handle = event.target.closest<HTMLElement>(
            ".resize__move, .resize__rd, .resize__ld, .resize__lt, .resize__rt, .resize__r, .resize__d, .resize__t, .resize__l",
        );
        if (!handle || !this.element.contains(handle)) {
            return;
        }
        const direction = handle.classList.contains("resize__move")
            ? "move"
            : RESIZE_DIRECTIONS.find((item) => handle.classList.contains(`resize__${item}`))!;
        const startX = event.clientX;
        const startY = event.clientY;
        const startRect = this.element.getBoundingClientRect();
        const dragController = new AbortController();
        const dragSignal = combineAbortSignals([this.ownerController.signal, dragController.signal]);
        let moved = false;

        this.bringToFront();
        this.element.style.userSelect = "none";
        event.preventDefault();

        document.addEventListener("pointermove", (moveEvent) => {
            if (moveEvent.pointerId !== event.pointerId) {
                return;
            }
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            if (!moved) {
                moved = true;
                this.setPinned(true);
            }
            if (direction === "move") {
                this.movePanel(startRect, deltaX, deltaY);
            } else {
                this.resizePanel(direction, startRect, deltaX, deltaY);
            }
            moveEvent.preventDefault();
        }, {signal: dragSignal});
        const finish = (finishEvent: PointerEvent) => {
            if (finishEvent.pointerId !== event.pointerId) {
                return;
            }
            dragController.abort();
            this.element.style.userSelect = "";
        };
        document.addEventListener("pointerup", finish, {signal: dragSignal});
        document.addEventListener("pointercancel", finish, {signal: dragSignal});
    };

    private movePanel(startRect: DOMRect, deltaX: number, deltaY: number) {
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        this.element.style.left = `${clamp(startRect.left + deltaX, 0, viewportWidth - startRect.width)}px`;
        this.element.style.top = `${clamp(startRect.top + deltaY, 0, viewportHeight - startRect.height)}px`;
    }

    private resizePanel(direction: ResizeDirection, startRect: DOMRect, deltaX: number, deltaY: number) {
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const minWidth = Math.min(MIN_PANEL_WIDTH, viewportWidth);
        const minHeight = Math.min(MIN_PANEL_HEIGHT, viewportHeight);
        let left = startRect.left;
        let right = startRect.right;
        let top = startRect.top;
        let bottom = startRect.bottom;

        if (direction.includes("l")) {
            left = clamp(startRect.left + deltaX, 0, right - minWidth);
        }
        if (direction.includes("r")) {
            right = clamp(startRect.right + deltaX, left + minWidth, viewportWidth);
        }
        if (direction.includes("t")) {
            top = clamp(startRect.top + deltaY, 0, bottom - minHeight);
        }
        if (direction.includes("d")) {
            bottom = clamp(startRect.bottom + deltaY, top + minHeight, viewportHeight);
        }

        this.element.style.left = `${left}px`;
        this.element.style.top = `${top}px`;
        this.element.style.width = `${right - left}px`;
        this.element.style.height = `${bottom - top}px`;
        this.element.style.maxWidth = "none";
        this.element.style.maxHeight = "none";
    }
}

export const openBlockPanel = (options: OpenBlockPanelOptions): BlockPanelHandle =>
    new BlockPanelOwner(options);
