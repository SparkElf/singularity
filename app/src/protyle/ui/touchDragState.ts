import type {ProtyleOverlayHandle} from "../../../../enterprise/packages/protyle-browser/src/contracts";

interface TouchDragGhostRegistration {
    readonly element: HTMLElement;
    readonly handle: ProtyleOverlayHandle;
    readonly removeAbortListener: () => void;
}

interface TouchDragGesture {
    ghost?: TouchDragGhostRegistration;
    readonly onRequestAbort: () => void;
}

/** 浏览器桥接的一次触控拖拽状态；原生移动端和文件树保留各自的本地状态。 */
class TouchDragOwner {
    private gesture: TouchDragGesture | undefined;

    get active() {
        return this.gesture !== undefined;
    }

    get ghost() {
        return this.gesture?.ghost?.element ?? null;
    }

    begin(onRequestAbort: () => void) {
        if (this.gesture) {
            return false;
        }
        this.gesture = {onRequestAbort};
        return true;
    }

    registerGhost(element: HTMLElement, handle: ProtyleOverlayHandle, requestSignal: AbortSignal) {
        const gesture = this.gesture!;
        this.releaseGhost(gesture.ghost);

        let registration: TouchDragGhostRegistration;
        const onAbort = () => {
            if (this.gesture !== gesture || gesture.ghost !== registration) {
                return;
            }
            gesture.onRequestAbort();
        };
        registration = {
            element,
            handle,
            removeAbortListener: () => requestSignal.removeEventListener("abort", onAbort),
        };
        gesture.ghost = registration;
        requestSignal.addEventListener("abort", onAbort, {once: true});
        if (requestSignal.aborted) {
            onAbort();
        }
    }

    finish() {
        const gesture = this.gesture;
        if (!gesture) {
            return false;
        }
        this.gesture = undefined;
        this.releaseGhost(gesture.ghost);
        return true;
    }

    private releaseGhost(registration?: TouchDragGhostRegistration) {
        if (!registration) {
            return;
        }
        registration.removeAbortListener();
        registration.handle.close();
    }
}

export const touchDragOwner = new TouchDragOwner();
