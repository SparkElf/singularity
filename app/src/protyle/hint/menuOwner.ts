export interface OwnedHintMenu {
    readonly menu: ReturnType<TProtyleRuntime["menu"]["open"]>["menu"];
    close: () => void;
}

/** 一个 Hint 只持有自己触发的菜单实例；Session 继续持有菜单能力本身。 */
export class HintMenuOwner {
    private current?: ReturnType<TProtyleRuntime["menu"]["open"]>;

    constructor(private readonly protyle: IProtyle) {
        protyle.requestSignal.addEventListener("abort", () => this.close(), {once: true});
        document.addEventListener("pointerdown", (event) => {
            const target = event.target;
            if (this.current && target instanceof Node && !this.current.menu.element.contains(target)) {
                this.close();
            }
        }, {capture: true, signal: protyle.requestSignal});
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && this.current) {
                this.close();
            }
        }, {capture: true, signal: protyle.requestSignal});
    }

    public open(onClose?: () => void): OwnedHintMenu {
        this.close();
        const runtime = this.protyle.session!.runtime as TProtyleRuntime;
        const handle = runtime.menu.open();
        this.current = handle;
        handle.menu.removeCB = () => {
            if (this.current === handle) {
                this.current = undefined;
            }
            onClose?.();
        };
        return {
            menu: handle.menu,
            close: () => this.close(handle),
        };
    }

    public close(handle = this.current) {
        if (!handle) {
            return;
        }
        if (this.current === handle) {
            this.current = undefined;
        }
        handle.close();
    }
}
