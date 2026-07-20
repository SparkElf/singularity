import type {
  ProtyleApplicationPort,
  ProtyleCoreDocumentOptions,
  ProtyleLocalizationPort,
  ProtyleMenuSurface,
  ProtyleWorkspaceCoreFactory,
} from "./contracts.ts";

export interface RealProtyleBrowserMenuOptions {
  readonly localization: ProtyleLocalizationPort;
  readonly portalRoot: HTMLElement;
  readonly requestClose: () => void;
}

export interface RealProtyleApplicationBinding {
  readonly application: Pick<ProtyleApplicationPort, "localization" | "settings">;
}

/** 声明运行时桥接的公共合同，避免类型检查穿透到旧 App 的完整源码树。 */
export declare function createRealProtyleBrowserCoreFactory<TRuntime = unknown>(
  binding: RealProtyleApplicationBinding,
): ProtyleWorkspaceCoreFactory<ProtyleCoreDocumentOptions, TRuntime>;

/** 创建与 Protyle 菜单端口兼容、可由空间 Session 管理的菜单表面。 */
export declare function createRealProtyleBrowserMenu(
  options: RealProtyleBrowserMenuOptions,
): ProtyleMenuSurface & { readonly dispose: () => void };

export declare function cancelTouchDragBridgeGesture(): void;
export declare function installTouchDragBridge(): () => void;
