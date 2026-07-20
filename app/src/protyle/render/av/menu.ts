type AVMenuHandle = ReturnType<NonNullable<IProtyle["runtime"]>["menu"]["open"]>;
export type AVMenuSurface = AVMenuHandle["menu"];

interface ActiveAVMenu {
    readonly handle: AVMenuHandle;
    readonly key?: string;
}

const activeMenus = new WeakMap<IProtyle, ActiveAVMenu>();

export const closeAVMenu = (protyle: IProtyle) => {
    activeMenus.get(protyle)?.handle.close();
};

export const isAVMenuOpen = (protyle: IProtyle) => activeMenus.has(protyle);

export const openAVMenu = (
    protyle: IProtyle,
    key?: string,
    onClose?: (menu: AVMenuHandle["menu"]) => void | Promise<void>,
): AVMenuHandle | undefined => {
    const active = activeMenus.get(protyle);
    if (active) {
        const toggled = key !== undefined && active.key === key;
        active.handle.close();
        if (toggled) {
            return undefined;
        }
    }

    const handle = protyle.runtime.menu.open();
    const closeOnOwnerAbort = () => handle.close();
    protyle.requestSignal.addEventListener("abort", closeOnOwnerAbort, {once: true});
    handle.menu.removeCB = () => {
        protyle.requestSignal.removeEventListener("abort", closeOnOwnerAbort);
        if (activeMenus.get(protyle)?.handle === handle) {
            activeMenus.delete(protyle);
        }
        const result = onClose?.(handle.menu);
        if (result instanceof Promise) {
            void result.catch((error) => {
                console.error("[protyle.av.menu] close action failed", error);
            });
        }
    };
    activeMenus.set(protyle, {handle, key});
    return handle;
};
