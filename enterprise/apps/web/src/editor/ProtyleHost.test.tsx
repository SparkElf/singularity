import "@testing-library/jest-dom/vitest";
import type {
  ProtyleController,
  ProtyleFactory,
  ProtyleSession,
} from "@singularity/protyle-browser";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProtyleHost } from "./ProtyleHost.tsx";

function createController(): ProtyleController {
  return {
    destroy: vi.fn(),
    focus: vi.fn(),
    setReadOnly: vi.fn(),
  };
}

function createSession(spaceId: string): ProtyleSession {
  return {
    dispose: vi.fn(),
    host: { dispatch: vi.fn() },
    spaceId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ProtyleHost", () => {
  it("recreates the editor for a different document and updates read-only state in place", async () => {
    const firstController = createController();
    const secondController = createController();
    const create = vi.fn<ProtyleFactory["create"]>()
      .mockResolvedValueOnce(firstController)
      .mockResolvedValueOnce(secondController);
    const factory: ProtyleFactory = { create };
    const session = createSession("space-a");

    const { getByTestId, rerender, unmount } = render(
      <ProtyleHost documentId="doc-a" factory={factory} readOnly={false} session={session} />,
    );

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      documentId: "doc-a",
      readOnly: false,
      session,
    });

    rerender(<ProtyleHost documentId="doc-a" factory={factory} readOnly session={session} />);
    await waitFor(() => expect(firstController.setReadOnly).toHaveBeenLastCalledWith(true));
    expect(create).toHaveBeenCalledOnce();

    rerender(<ProtyleHost documentId="doc-b" factory={factory} readOnly session={session} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(firstController.destroy).toHaveBeenCalledOnce();
    expect(create.mock.calls[1]?.[0]).toMatchObject({ documentId: "doc-b", session });
    await waitFor(() => expect(getByTestId("protyle-host")).toHaveAttribute("aria-busy", "false"));

    unmount();
    expect(secondController.destroy).toHaveBeenCalledOnce();
  });

  it("destroys a controller that resolves after its document lifecycle was aborted", async () => {
    const lateController = createController();
    const activeController = createController();
    const lateCreation = deferred<ProtyleController>();
    const create = vi.fn<ProtyleFactory["create"]>()
      .mockReturnValueOnce(lateCreation.promise)
      .mockResolvedValueOnce(activeController);
    const factory: ProtyleFactory = { create };
    const session = createSession("space-a");

    const { getByTestId, rerender, unmount } = render(
      <ProtyleHost documentId="doc-a" factory={factory} readOnly={false} session={session} />,
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());

    rerender(<ProtyleHost documentId="doc-b" factory={factory} readOnly={false} session={session} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getByTestId("protyle-host")).toHaveAttribute("aria-busy", "false"));

    lateCreation.resolve(lateController);
    await waitFor(() => expect(lateController.destroy).toHaveBeenCalledOnce());
    expect(activeController.destroy).not.toHaveBeenCalled();

    unmount();
    expect(activeController.destroy).toHaveBeenCalledOnce();
  });

  it("surfaces editor creation failures through the host contract", async () => {
    const creationError = new Error("creation failed");
    const onError = vi.fn();
    const factory: ProtyleFactory = {
      create: vi.fn().mockRejectedValue(creationError),
    };

    const { findByRole } = render(
      <ProtyleHost
        documentId="doc-a"
        factory={factory}
        onError={onError}
        readOnly={false}
        session={createSession("space-a")}
      />,
    );

    const alert = await findByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent("编辑器加载失败");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(creationError);
  });
});
