import "@testing-library/jest-dom/vitest";
import type { SpaceRuntimeBootstrap } from "@singularity/contracts";
import type { ProtyleSession } from "@singularity/protyle-browser";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SpaceProtyleMenuSurfaceFactory,
  SpaceProtyleRuntime,
  SpaceSessionComposition,
} from "@/spaces/space-session.ts";
import { SpaceSessionRoot } from "@/spaces/SpaceSessionRoot.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const createTestProtyleMenuSurface: SpaceProtyleMenuSurfaceFactory = () => {
  throw new Error("Menu creation is outside the session lifecycle test scope");
};

function readyBootstrap(spaceId: string): SpaceRuntimeBootstrap & {
  readonly kernelState: "ready";
} {
  return {
    kernelState: "ready",
    organizationId: ORGANIZATION_ID,
    role: "admin",
    spaceId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SpaceSessionRoot", () => {
  it("hands the active session directly to its owner and disposes it before rendering the next space", async () => {
    let activeSession: ProtyleSession<SpaceProtyleRuntime> | null = null;
    const onAccessLost = vi.fn();
    const retryRuntime = vi.fn<() => Promise<SpaceRuntimeBootstrap>>();
    const { rerender } = render(
      <SpaceSessionRoot
        bootstrap={readyBootstrap(SPACE_A)}
        createProtyleMenuSurface={createTestProtyleMenuSurface}
        onAccessLost={onAccessLost}
        onHostEvent={vi.fn()}
        retryRuntime={retryRuntime}
      >
        {(composition) => {
          activeSession = composition?.session ?? null;
          return <div>{composition?.session?.spaceId ?? "none"}</div>;
        }}
      </SpaceSessionRoot>,
    );

    expect(await screen.findByText(SPACE_A)).toBeVisible();
    const firstSession = activeSession;
    expect(firstSession).not.toBeNull();

    rerender(
      <SpaceSessionRoot
        bootstrap={readyBootstrap(SPACE_B)}
        createProtyleMenuSurface={createTestProtyleMenuSurface}
        onAccessLost={onAccessLost}
        onHostEvent={vi.fn()}
        retryRuntime={retryRuntime}
      >
        {(composition) => {
          activeSession = composition?.session ?? null;
          return <div>{composition?.session?.spaceId ?? "none"}</div>;
        }}
      </SpaceSessionRoot>,
    );

    expect(await screen.findByText(SPACE_B)).toBeVisible();
    const nextSession = activeSession as ProtyleSession<SpaceProtyleRuntime>;
    expect(nextSession.spaceId).toBe(SPACE_B);
    const disposedSession = firstSession as ProtyleSession<SpaceProtyleRuntime>;
    await expect(disposedSession.retrySubmission()).rejects.toThrowError(
      /after disposal/,
    );
    expect(onAccessLost).not.toHaveBeenCalled();
  });

  it("rejects a prior selection capability when the same authorized space starts a new generation", async () => {
    let currentComposition: SpaceSessionComposition | null = null;
    const renderOwner = (composition: SpaceSessionComposition | null) => {
      currentComposition = composition;
      return <div>{composition?.session?.spaceId ?? "none"}</div>;
    };
    const rootProps = {
      createProtyleMenuSurface: createTestProtyleMenuSurface,
      onAccessLost: vi.fn(),
      onHostEvent: vi.fn(),
      retryRuntime: vi.fn<() => Promise<SpaceRuntimeBootstrap>>(),
    };
    const { rerender } = render(
      <SpaceSessionRoot bootstrap={readyBootstrap(SPACE_A)} {...rootProps}>
        {renderOwner}
      </SpaceSessionRoot>,
    );

    expect(await screen.findByText(SPACE_A)).toBeVisible();
    const firstComposition = currentComposition as SpaceSessionComposition;
    act(() => {
      expect(firstComposition.selectDocument({
        documentId: "20260718000100-docum01",
        notebookId: "20260718000000-noteb01",
      })).toBe(true);
    });

    rerender(
      <SpaceSessionRoot bootstrap={null} {...rootProps}>
        {renderOwner}
      </SpaceSessionRoot>,
    );
    await waitFor(() => expect(currentComposition).toBeNull());
    rerender(
      <SpaceSessionRoot bootstrap={readyBootstrap(SPACE_A)} {...rootProps}>
        {renderOwner}
      </SpaceSessionRoot>,
    );

    expect(await screen.findByText(SPACE_A)).toBeVisible();
    const nextComposition = currentComposition as SpaceSessionComposition;
    expect(nextComposition.scope).not.toBe(firstComposition.scope);
    act(() => {
      expect(firstComposition.selectDocument({
        documentId: "20260718000101-stale01",
        notebookId: "20260718000000-noteb01",
      })).toBe(false);
    });
    expect(nextComposition.selection).toBeNull();
  });

  it("disposes a terminal runtime before clearing the owner and notifying access loss", async () => {
    let activeSession: ProtyleSession<SpaceProtyleRuntime> | null = null;
    let firstSession: ProtyleSession<SpaceProtyleRuntime> | null = null;
    const notificationGate = deferred<void>();
    const onAccessLost = vi.fn(async () => {
      expect(firstSession).not.toBeNull();
      await expect(firstSession!.retrySubmission()).rejects.toThrowError(
        /after disposal/,
      );
      await notificationGate.promise;
    });
    render(
      <SpaceSessionRoot
        bootstrap={readyBootstrap(SPACE_A)}
        createProtyleMenuSurface={createTestProtyleMenuSurface}
        onAccessLost={onAccessLost}
        onHostEvent={vi.fn()}
        retryRuntime={vi.fn()}
      >
        {(composition) => {
          activeSession = composition?.session ?? null;
          firstSession ??= composition?.session ?? null;
          return <div>{composition?.session?.spaceId ?? "none"}</div>;
        }}
      </SpaceSessionRoot>,
    );

    expect(await screen.findByText(SPACE_A)).toBeVisible();
    expect(firstSession).not.toBeNull();
    act(() => {
      firstSession!.runtime.host.dispatch({
        category: "forbidden",
        requestId: "99999999-9999-4999-8999-999999999999",
        type: "runtime-error",
      });
    });

    await waitFor(() => expect(onAccessLost).toHaveBeenCalledOnce());
    expect(screen.getByText("none")).toBeVisible();
    expect(activeSession).toBeNull();
    notificationGate.resolve();
  });

  it("keeps the current session mounted when the content service is temporarily unavailable", async () => {
    let activeSession: ProtyleSession<SpaceProtyleRuntime> | null = null;
    const onAccessLost = vi.fn();
    render(
      <SpaceSessionRoot
        bootstrap={readyBootstrap(SPACE_A)}
        createProtyleMenuSurface={createTestProtyleMenuSurface}
        onAccessLost={onAccessLost}
        onHostEvent={vi.fn()}
        retryRuntime={vi.fn()}
      >
        {(composition) => {
          activeSession = composition?.session ?? null;
          return <div>{composition?.session?.spaceId ?? "none"}</div>;
        }}
      </SpaceSessionRoot>,
    );

    expect(await screen.findByText(SPACE_A)).toBeVisible();
    act(() => {
      activeSession!.runtime.host.dispatch({
        category: "kernel-unavailable",
        requestId: "99999999-9999-4999-8999-999999999999",
        type: "runtime-error",
      });
    });

    expect(screen.getByText(SPACE_A)).toBeVisible();
    const currentSession = activeSession as ProtyleSession<SpaceProtyleRuntime>;
    expect(currentSession.spaceId).toBe(SPACE_A);
    expect(onAccessLost).not.toHaveBeenCalled();
  });

  it("forwards non-terminal host events to the React mediator with the bound space", async () => {
    let activeSession: ProtyleSession<SpaceProtyleRuntime> | null = null;
    const onHostEvent = vi.fn();
    render(
      <SpaceSessionRoot
        bootstrap={readyBootstrap(SPACE_A)}
        createProtyleMenuSurface={createTestProtyleMenuSurface}
        onAccessLost={vi.fn()}
        onHostEvent={onHostEvent}
        retryRuntime={vi.fn()}
      >
        {(composition) => {
          activeSession = composition?.session ?? null;
          return <div>{composition?.session?.spaceId ?? "none"}</div>;
        }}
      </SpaceSessionRoot>,
    );

    expect(await screen.findByText(SPACE_A)).toBeVisible();
    act(() => {
      activeSession!.runtime.host.dispatch({
        attention: "none",
        blockId: "20260718000100-docum01",
        disposition: "current",
        documentId: "20260718000100-docum01",
        notebookId: "20260718000000-noteb01",
        restoreScroll: "never",
        scope: "target",
        scroll: "auto",
        sourceEditorId: "editor-primary",
        type: "open-document",
        zoom: false,
      });
    });

    await waitFor(() => expect(onHostEvent).toHaveBeenCalledOnce());
    expect(onHostEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        blockId: "20260718000100-docum01",
        documentId: "20260718000100-docum01",
        notebookId: "20260718000000-noteb01",
        sourceEditorId: "editor-primary",
        type: "open-document",
      }),
      readyBootstrap(SPACE_A),
    );
  });
});
