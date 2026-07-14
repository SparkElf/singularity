import "@testing-library/jest-dom/vitest";
import type {
  ProtyleController,
  ProtyleFactory,
} from "@singularity/protyle-browser";
import {
  createProtyleEditorRegistry,
  createProtyleMenuPort,
  createProtyleOverlayPort,
  createProtyleSession,
} from "@singularity/protyle-browser";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProtyleHost } from "./ProtyleHost.tsx";

function createController() {
  return {
    destroy: vi.fn(),
    focus: vi.fn(),
    setHostReadOnly: vi.fn(),
  } satisfies ProtyleController;
}

function createSession(spaceId: string) {
  return createProtyleSession({
    spaceId,
    runtime: {
      editors: createProtyleEditorRegistry(),
      menu: createProtyleMenuPort(() => ({}), () => undefined),
      overlays: createProtyleOverlayPort(() => undefined),
      plugins: { dispose: () => undefined },
      transport: { dispose: () => undefined },
    },
    retrySubmission: () => Promise.resolve(),
  });
}

type TestSession = ReturnType<typeof createSession>;
type TestFactory = ProtyleFactory<TestSession["runtime"]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ProtyleHost", () => {
  it("uses the public factory contract and updates the host read-only constraint in place", async () => {
    const controller = createController();
    const create = vi.fn<TestFactory["create"]>().mockResolvedValue(controller);
    const factory: TestFactory = { create };
    const session = createSession("space-a");

    const { getByTestId, rerender, unmount } = render(
      <ProtyleHost documentId="doc-a" factory={factory} readOnly={false} session={session} />,
    );

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const createOptions = create.mock.calls[0]?.[0];
    expect(createOptions).toMatchObject({
      documentId: "doc-a",
      host: getByTestId("protyle-host"),
      readOnly: false,
      session,
    });
    expect(Object.keys(createOptions ?? {}).sort()).toEqual(["documentId", "host", "readOnly", "session", "signal"]);
    expect(createOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(createOptions?.signal.aborted).toBe(false);
    await waitFor(() => expect(getByTestId("protyle-host")).toHaveAttribute("aria-busy", "false"));
    expect(controller.setHostReadOnly).not.toHaveBeenCalled();

    rerender(<ProtyleHost documentId="doc-a" factory={factory} readOnly session={session} />);
    await waitFor(() => expect(controller.setHostReadOnly).toHaveBeenCalledOnce());
    expect(controller.setHostReadOnly).toHaveBeenLastCalledWith(true);
    expect(create).toHaveBeenCalledOnce();

    unmount();
    expect(createOptions?.signal.aborted).toBe(true);
    expect(controller.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the current editor before recreating it for document and session changes", async () => {
    const firstController = createController();
    const secondController = createController();
    const thirdController = createController();
    const create = vi.fn<TestFactory["create"]>()
      .mockResolvedValueOnce(firstController)
      .mockResolvedValueOnce(secondController)
      .mockResolvedValueOnce(thirdController);
    const factory: TestFactory = { create };
    const firstSession = createSession("space-a");
    const replacementSession = createSession("space-a");

    const { rerender, unmount } = render(
      <ProtyleHost documentId="doc-a" factory={factory} readOnly={false} session={firstSession} />,
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());

    rerender(<ProtyleHost documentId="doc-b" factory={factory} readOnly={false} session={firstSession} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(firstController.destroy).toHaveBeenCalledOnce();
    expect(firstController.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[1] ?? 0,
    );
    expect(create.mock.calls[1]?.[0]).toMatchObject({ documentId: "doc-b", session: firstSession });

    rerender(
      <ProtyleHost documentId="doc-b" factory={factory} readOnly={false} session={replacementSession} />,
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(create.mock.calls[1]?.[0].signal.aborted).toBe(true);
    expect(secondController.destroy).toHaveBeenCalledOnce();
    expect(secondController.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[2] ?? 0,
    );
    expect(create.mock.calls[2]?.[0]).toMatchObject({ documentId: "doc-b", session: replacementSession });

    unmount();
    expect(create.mock.calls[2]?.[0].signal.aborted).toBe(true);
    expect(thirdController.destroy).toHaveBeenCalledOnce();
  });

  it("destroys a controller that resolves after its document lifecycle was aborted", async () => {
    const lateController = createController();
    const activeController = createController();
    const lateCreation = deferred<ProtyleController>();
    const create = vi.fn<TestFactory["create"]>()
      .mockReturnValueOnce(lateCreation.promise)
      .mockResolvedValueOnce(activeController);
    const factory: TestFactory = { create };
    const session = createSession("space-a");

    const { getByTestId, rerender, unmount } = render(
      <ProtyleHost documentId="doc-a" factory={factory} readOnly={false} session={session} />,
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());

    rerender(<ProtyleHost documentId="doc-b" factory={factory} readOnly={false} session={session} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await waitFor(() => expect(getByTestId("protyle-host")).toHaveAttribute("aria-busy", "false"));

    lateCreation.resolve(lateController);
    await waitFor(() => expect(lateController.destroy).toHaveBeenCalledOnce());
    expect(activeController.destroy).not.toHaveBeenCalled();

    unmount();
    expect(create.mock.calls[1]?.[0].signal.aborted).toBe(true);
    expect(activeController.destroy).toHaveBeenCalledOnce();
  });

  it("keeps creation failures visible until a new editor lifecycle succeeds", async () => {
    const creationError = new Error("creation failed");
    const recoveredController = createController();
    const onError = vi.fn();
    const create = vi.fn<TestFactory["create"]>()
      .mockRejectedValueOnce(creationError)
      .mockResolvedValueOnce(recoveredController);
    const factory: TestFactory = { create };
    const session = createSession("space-a");

    const { findByRole, getByTestId, queryByRole, rerender, unmount } = render(
      <ProtyleHost
        documentId="doc-a"
        factory={factory}
        onError={onError}
        readOnly={false}
        session={session}
      />,
    );

    const alert = await findByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent("编辑器加载失败");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(creationError);
    expect(getByTestId("protyle-host")).toHaveAttribute("aria-busy", "false");

    rerender(<ProtyleHost documentId="doc-a" factory={factory} onError={onError} readOnly session={session} />);
    expect(queryByRole("alert")).toBeVisible();
    expect(create).toHaveBeenCalledOnce();

    rerender(<ProtyleHost documentId="doc-b" factory={factory} onError={onError} readOnly session={session} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryByRole("alert")).not.toBeInTheDocument());
    expect(getByTestId("protyle-host")).toHaveAttribute("aria-busy", "false");
    expect(onError).toHaveBeenCalledOnce();

    unmount();
    expect(recoveredController.destroy).toHaveBeenCalledOnce();
  });
});
