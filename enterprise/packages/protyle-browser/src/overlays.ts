import type { ProtyleOverlayHandle, ProtyleOverlayPort } from "./contracts.ts";

/** 创建浮层能力端口，统一管理注册、置顶、关闭回调和批量销毁。 */
export function createProtyleOverlayPort<TOverlay>(
  closeOverlay: (overlay: TOverlay) => void,
): ProtyleOverlayPort<TOverlay> {
  interface Registration {
    readonly overlay: TOverlay;
    readonly handle: ProtyleOverlayHandle;
  }

  const registrations = new Set<Registration>();
  let disposed = false;

  const bringToFront = (overlay: TOverlay) => {
    const registration = Array.from(registrations).find((item) => item.overlay === overlay);
    if (!registration) {
      throw new Error("[protyle.overlays] cannot activate an unregistered overlay");
    }
    if (typeof HTMLElement === "undefined" || !(overlay instanceof HTMLElement)) {
      throw new Error("[protyle.overlays] bringToFront requires a browser overlay element");
    }
    const maxZIndex = Array.from(registrations).reduce((max, item) => {
      const value = Number.parseInt(
        typeof HTMLElement !== "undefined" && item.overlay instanceof HTMLElement
          ? item.overlay.style.zIndex
          : "",
        10,
      );
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0);
    overlay.style.zIndex = String(maxZIndex + 1);
  };

  return {
    add: (overlay, onBeforeClose) => {
      if (disposed) {
        throw new Error("[protyle.overlays] cannot add an overlay after disposal");
      }

      let closed = false;
      const registration: Registration = {
        overlay,
        handle: {
          close: () => {
            if (closed) {
              return;
            }
            closed = true;
            registrations.delete(registration);
            try {
              onBeforeClose?.();
            } finally {
              closeOverlay(overlay);
            }
          },
        },
      };
      registrations.add(registration);
      return registration.handle;
    },
    bringToFront,
    forEach: (visitor) => {
      registrations.forEach(({ overlay }) => visitor(overlay));
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const failures: unknown[] = [];
      Array.from(registrations).forEach(({ handle }) => {
        try {
          handle.close();
        } catch (error) {
          console.error("[protyle.overlays] overlay disposal failed", error);
          failures.push(error);
        }
      });
      if (failures.length > 0) {
        throw new AggregateError(failures, "[protyle.overlays] overlay disposal failed");
      }
    },
  };
}
