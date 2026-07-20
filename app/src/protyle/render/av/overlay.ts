import type {ProtyleOverlayHandle} from "../../../../../enterprise/packages/protyle-browser/src/contracts";

export type AVOverlayKind = "cell-editor" | "panel";

interface AVOverlayRegistration {
    readonly controller: AbortController;
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
    registration.controller.abort();
    registration.handle.close();
};

export const closeOwnedAVOverlay = (protyle: IProtyle, kind: AVOverlayKind, element: Element) => {
    const registration = registrationsFor(protyle).get(kind);
    if (registration?.element === element) {
        closeAVOverlay(protyle, kind);
    }
};

export const currentAVOverlay = (protyle: IProtyle, kind: AVOverlayKind) => {
    const ownerRegistrations = registrationsFor(protyle);
    const registration = ownerRegistrations.get(kind);
    if (!registration?.element.isConnected) {
        if (registration) {
            closeAVOverlay(protyle, kind);
        }
        return undefined;
    }
    return registration.element;
};

export const currentAVOverlaySignal = (protyle: IProtyle, kind: AVOverlayKind) => {
    const registration = registrationsFor(protyle).get(kind);
    if (!registration?.element.isConnected) {
        if (registration) {
            closeAVOverlay(protyle, kind);
        }
        return undefined;
    }
    return registration.controller.signal;
};

export const registerAVOverlay = (protyle: IProtyle, kind: AVOverlayKind, element: HTMLElement) => {
    closeAVOverlay(protyle, kind);
    const overlays = protyle.runtime.overlays;
    const registration = {
        controller: new AbortController(),
        element,
        handle: overlays.add(element),
    };
    registrationsFor(protyle).set(kind, registration);
    overlays.bringToFront(element);
    return registration;
};
