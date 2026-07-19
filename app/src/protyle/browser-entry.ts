/// <reference path="../types/config.d.ts" />
/// <reference path="../types/index.d.ts" />
/// <reference path="../types/protyle.d.ts" />

import {Protyle} from "./index";
import {ProtyleDOMMenu} from "./ui/Menu";
import {isNarrowViewport} from "./util/browserPlatform";
import {updateHotkeyTip} from "./util/keyboard";
import type {
    ProtyleApplicationPort,
    ProtyleController,
    ProtyleLocalizationPort,
    ProtyleWorkspaceCoreCreateOptions,
    ProtyleWorkspaceCoreFactory,
} from "../../../enterprise/packages/protyle-browser/src/contracts";

export {cancelTouchDragBridgeGesture, installTouchDragBridge} from "./ui/touchDragBridge";

export interface RealProtyleBrowserMenuOptions {
    readonly localization: ProtyleLocalizationPort;
    readonly portalRoot: HTMLElement;
    readonly requestClose: () => void;
}

export const createRealProtyleBrowserMenu = (
    options: RealProtyleBrowserMenuOptions,
): ProtyleDOMMenu => new ProtyleDOMMenu({
    formatHotkey: updateHotkeyTip,
    isNarrowViewport,
    localization: options.localization,
    portalRoot: options.portalRoot,
    requestClose: options.requestClose,
});

export interface RealProtyleApplicationBinding {
    /** 只接收显式浏览器应用端口；内容能力由 bound Session 提供。 */
    readonly application: Pick<ProtyleApplicationPort, "localization" | "settings">;
}

export type RealProtyleWorkspaceCoreFactory<TRuntime = unknown> =
    ProtyleWorkspaceCoreFactory<IProtyleOptions, TRuntime>;

const abortError = (signal: AbortSignal): DOMException =>
    signal.reason instanceof DOMException
        ? signal.reason
        : new DOMException("Protyle creation was aborted", "AbortError");

/**
 * Explicit migration entry for the real Protyle DOM Core.
 *
 * 该入口只接收显式应用端口。旧工作台、Kernel 传输和内容身份不得通过
 * App、全局状态或布局对象隐式进入 Core。
 */
export function createRealProtyleBrowserCoreFactory<TRuntime = unknown>(
    binding: RealProtyleApplicationBinding,
): RealProtyleWorkspaceCoreFactory<TRuntime> {
    const application = binding.application;

    return {
        create: async (
            options: ProtyleWorkspaceCoreCreateOptions<IProtyleOptions, TRuntime>,
        ): Promise<ProtyleController> => {
            if (options.signal.aborted) {
                throw abortError(options.signal);
            }
            const editor = new Protyle(application, options.host, options.options, {
                content: options.content,
                initialLoad: options.initialLoad,
                participation: options.participation,
                session: options.session,
                signal: options.signal,
                surface: options.surface,
                hostReadOnly: options.readOnly,
            });
            let disposed = false;
            const onAbort = () => {
                if (!disposed) {
                    disposed = true;
                    editor.destroy();
                }
            };
            options.signal.addEventListener("abort", onAbort, {once: true});

            if (options.signal.aborted) {
                onAbort();
                throw abortError(options.signal);
            }

            return {
                destroy: () => {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    options.signal.removeEventListener("abort", onAbort);
                    editor.destroy();
                },
                focus: () => {
                    if (disposed) {
                        throw new Error(
                            "A destroyed Protyle Core cannot be focused.",
                        );
                    }
                    editor.focus();
                },
                navigateDocument: (navigation) => {
                    if (disposed) {
                        return Promise.reject(new Error(
                            "A destroyed Protyle Core cannot navigate documents.",
                        ));
                    }
                    return editor.navigateDocument(navigation);
                },
                setHostReadOnly: (readOnly) => {
                    if (disposed) {
                        throw new Error(
                            "A destroyed Protyle Core cannot change host read-only state.",
                        );
                    }
                    editor.setHostReadOnly(readOnly);
                },
            };
        },
    };
}
