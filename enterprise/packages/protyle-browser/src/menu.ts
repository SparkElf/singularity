import type { ProtyleMenuHandle, ProtyleMenuPort } from "./contracts.ts";

export function createProtyleMenuPort<TMenu>(
  openMenu: () => TMenu,
  closeMenu: (menu: TMenu) => void,
): ProtyleMenuPort<TMenu> {
  const handles = new Set<ProtyleMenuHandle<TMenu>>();
  let disposed = false;

  return {
    open: () => {
      if (disposed) {
        throw new Error("[protyle.menu] cannot open a menu after disposal");
      }

      const menu = openMenu();
      let closed = false;
      const handle: ProtyleMenuHandle<TMenu> = {
        menu,
        close: () => {
          if (closed) {
            return;
          }
          closed = true;
          handles.delete(handle);
          closeMenu(menu);
        },
      };
      handles.add(handle);
      return handle;
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      handles.forEach((handle) => handle.close());
    },
  };
}
