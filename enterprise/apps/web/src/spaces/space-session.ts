import type { SpaceRuntimeBootstrap } from "@singularity/contracts";
import {
  createEmptyProtylePluginPort,
  createProtyleEditorRegistry,
  createProtyleMenuPort,
  createProtyleOverlayPort,
  createProtyleSession,
  type ProtyleController,
  type ProtyleHostDispatchEvent,
  type ProtyleMenuSurface,
  type ProtyleRuntime,
  type ProtyleSession,
} from "@singularity/protyle-browser";

import { createSpaceGatewayResourcePort } from "@/spaces/gateway-paths.ts";
import {
  createSpaceGatewayTransport,
  type SpaceGatewayTransport,
} from "@/spaces/gateway-transport.ts";

export type ReadySpaceRuntimeBootstrap = SpaceRuntimeBootstrap & {
  readonly kernelState: "ready";
};

export interface SpaceProtyleMenuSurface extends ProtyleMenuSurface {
  dispose: () => void;
}

export type SpaceProtyleMenuSurfaceFactory = (options: {
  readonly portalRoot: HTMLElement;
  readonly requestClose: () => void;
}) => SpaceProtyleMenuSurface;

export type SpaceProtyleRuntime = Omit<
  ProtyleRuntime<
    ProtyleController,
    unknown,
    unknown,
    unknown,
    ProtyleMenuSurface,
    HTMLElement
  >,
  "transport"
> & {
  readonly transport: SpaceGatewayTransport<unknown>;
};

export interface CreateSpaceProtyleSessionOptions {
  readonly bootstrap: ReadySpaceRuntimeBootstrap;
  readonly createProtyleMenuSurface: SpaceProtyleMenuSurfaceFactory;
  readonly getCsrfToken: (signal: AbortSignal) => Promise<string>;
  readonly onHostEvent: (event: ProtyleHostDispatchEvent) => void;
  readonly portalRoot: HTMLElement;
  readonly retryRuntime: () => Promise<SpaceRuntimeBootstrap>;
}

export function createSpaceProtyleSession(
  options: CreateSpaceProtyleSessionOptions,
): ProtyleSession<SpaceProtyleRuntime> {
  const space = {
    organizationId: options.bootstrap.organizationId,
    spaceId: options.bootstrap.spaceId,
  };
  const host = { dispatch: options.onHostEvent };
  const transport = createSpaceGatewayTransport<unknown>({
    getCsrfToken: options.getCsrfToken,
    onRuntimeError: host.dispatch,
    space,
  });
  const runtime: SpaceProtyleRuntime = {
    editors: createProtyleEditorRegistry<ProtyleController>(),
    host,
    menu: createProtyleMenuPort(
      (close) => options.createProtyleMenuSurface({
        portalRoot: options.portalRoot,
        requestClose: close,
      }),
      (menu) => menu.dispose(),
    ),
    overlays: createProtyleOverlayPort((overlay: HTMLElement) => overlay.remove()),
    plugins: createEmptyProtylePluginPort<unknown, unknown, ProtyleController>(),
    resources: createSpaceGatewayResourcePort(space),
    transport,
  };

  return createProtyleSession({
    retrySubmission: async () => {
      const bootstrap = await options.retryRuntime();
      if (
        bootstrap.organizationId !== space.organizationId ||
        bootstrap.spaceId !== space.spaceId ||
        bootstrap.kernelState !== "ready"
      ) {
        throw new Error("[protyle.session] runtime retry did not authorize the current space");
      }
      transport.resumeSubmission();
    },
    runtime,
    spaceId: options.bootstrap.spaceId,
  });
}
