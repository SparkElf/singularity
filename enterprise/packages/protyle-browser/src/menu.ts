import type { ProtyleMenuHandle, ProtyleMenuPort } from "./contracts.ts";

/** 创建菜单能力端口，跟踪每个打开句柄并在会话销毁时关闭全部菜单。 */
export function createProtyleMenuPort<TMenu>(
  openMenu: (close: () => void) => TMenu,
  closeMenu: (menu: TMenu) => void,
): ProtyleMenuPort<TMenu> {
  const handles = new Set<ProtyleMenuHandle<TMenu>>();
  let disposed = false;

  return {
    open: () => {
      if (disposed) {
        throw new Error("[protyle.menu] cannot open a menu after disposal");
      }

      let menu!: TMenu;
      let closed = false;
      const handle: ProtyleMenuHandle<TMenu> = {
        get menu() {
          return menu;
        },
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
      try {
        menu = openMenu(handle.close);
      } catch (error) {
        closed = true;
        handles.delete(handle);
        throw error;
      }
      return handle;
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const failures: unknown[] = [];
      Array.from(handles).forEach((handle) => {
        try {
          handle.close();
        } catch (error) {
          console.error("[protyle.menu] menu disposal failed", error);
          failures.push(error);
        }
      });
      if (failures.length > 0) {
        throw new AggregateError(failures, "[protyle.menu] menu disposal failed");
      }
    },
  };
}
