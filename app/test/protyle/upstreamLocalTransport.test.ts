import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    createUpstreamLocalProtyleTransport,
    type UpstreamLocalSubscriptionOptions,
} from "../../src/protyle/runtime/upstreamLocalTransport";

describe("upstream local Protyle Transport", () => {
    it("preserves each sourceEditorId for WebSocket self-exclusion", () => {
        const connections: UpstreamLocalSubscriptionOptions<unknown>[] = [];
        const transport = createUpstreamLocalProtyleTransport<unknown>({
            connect: (options) => {
                connections.push(options);
                return {disconnect: () => undefined};
            },
            request: async () => {
                throw new Error("request is not used by this contract");
            },
            upload: async () => {
                throw new Error("upload is not used by this contract");
            },
        });

        transport.subscribe({
            documentId: "document-a",
            notebookId: "notebook-a",
            onMessage: () => undefined,
            sourceEditorId: "editor-a",
            type: "protyle",
        });
        transport.subscribe({
            documentId: "document-a",
            notebookId: "notebook-a",
            onMessage: () => undefined,
            sourceEditorId: "editor-b",
            type: "protyle",
        });

        assert.deepEqual(connections.map((connection) => connection.sourceEditorId), ["editor-a", "editor-b"]);
    });

    it("logs the original disconnect error before aggregating disposal failures", () => {
        const failure = new Error("disconnect failed");
        const logged: unknown[][] = [];
        const originalConsoleError = console.error;
        console.error = (...values: unknown[]) => logged.push(values);
        try {
            const transport = createUpstreamLocalProtyleTransport<unknown>({
                connect: () => ({disconnect: () => {
                    throw failure;
                }}),
                request: async () => {
                    throw new Error("request is not used by this contract");
                },
                upload: async () => {
                    throw new Error("upload is not used by this contract");
                },
            });
            transport.subscribe({
                documentId: "document-a",
                notebookId: "notebook-a",
                onMessage: () => undefined,
                sourceEditorId: "editor-a",
                type: "protyle",
            });

            assert.throws(() => transport.dispose(), AggregateError);
            assert.equal(logged.length, 1);
            assert.equal(logged[0][1], failure);
        } finally {
            console.error = originalConsoleError;
        }
    });
});
