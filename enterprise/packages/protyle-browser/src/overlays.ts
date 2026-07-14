import type { ProtyleOverlayHandle, ProtyleOverlayPort } from "./contracts.ts";

export function createProtyleOverlayPort<TOverlay>(
  closeOverlay: (overlay: TOverlay) => void,
): ProtyleOverlayPort<TOverlay> {
  interface Registration {
    readonly overlay: TOverlay;
    readonly handle: ProtyleOverlayHandle;
  }

  const registrations = new Set<Registration>();
  let disposed = false;

  return {
    add: (overlay) => {
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
            closeOverlay(overlay);
          },
        },
      };
      registrations.add(registration);
      return registration.handle;
    },
    forEach: (visitor) => {
      registrations.forEach(({ overlay }) => visitor(overlay));
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      registrations.forEach(({ handle }) => handle.close());
    },
  };
}
