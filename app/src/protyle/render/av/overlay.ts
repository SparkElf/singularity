import type {ProtyleOverlayHandle} from "../../../../../enterprise/packages/protyle-browser/src/contracts";

export type AVOverlayKind = "cell-editor" | "panel";

interface AVOverlayRegistration {
    readonly element: HTMLElement;
    readonly handle: ProtyleOverlayHandle;
}

const registrations = new WeakMap<IProtyle, Map<AVOverlayKind, AVOverlayRegistration>>();

const registrationsFor = (protyle: IProtyle) => {
    let ownerRegistrations = registrations.get(protyle);
    if (ownerRegistrations) {
        return ownerRegistrations;
    }
    ownerRegistrations = new Map();
    registrations.set(protyle, ownerRegistrations);
    return ownerRegistrations;
};

export const closeAVOverlay = (protyle: IProtyle, kind: AVOverlayKind) => {
    const ownerRegistrations = registrationsFor(protyle);
    const registration = ownerRegistrations.get(kind);
    if (!registration) {
        return;
    }
    ownerRegistrations.delete(kind);
    registration.handle.close();
};

export const currentAVOverlay = (protyle: IProtyle, kind: AVOverlayKind) => {
    const ownerRegistrations = registrationsFor(protyle);
    const registration = ownerRegistrations.get(kind);
    if (!registration?.element.isConnected) {
        ownerRegistrations.delete(kind);
        return undefined;
    }
    return registration.element;
};

export const registerAVOverlay = (protyle: IProtyle, kind: AVOverlayKind, element: HTMLElement) => {
    closeAVOverlay(protyle, kind);
    const overlays = protyle.session!.runtime.overlays;
    const registration = {
        element,
        handle: overlays.add(element),
    };
    registrationsFor(protyle).set(kind, registration);
    overlays.bringToFront(element);
    return registration;
};
