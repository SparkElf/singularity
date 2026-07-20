import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSpaceGatewayAssetDownloadPath,
  createSpaceGatewayResourcePort,
} from "@/spaces/gateway-paths.ts";

const space = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const identity = {
  documentId: "20260718000100-docum01",
  notebookId: "20260718000000-noteb01",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Space Gateway export resources", () => {
  it("builds a forced-download asset URL with the current content identity", () => {
    const resolved = new URL(
      buildSpaceGatewayAssetDownloadPath(space, identity, "assets/unsafe.html"),
      "https://singularity.invalid",
    );

    expect(resolved.pathname).toBe(
      "/api/v1/organizations/11111111-1111-4111-8111-111111111111/spaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/assets/unsafe.html",
    );
    expect(Object.fromEntries(resolved.searchParams)).toEqual({
      documentId: "20260718000100-docum01",
      download: "true",
      notebookId: "20260718000000-noteb01",
    });
  });

  it("maps the Kernel export path to an explicitly identified Gateway resource", () => {
    const resources = createSpaceGatewayResourcePort(space);
    const resolved = new URL(
      resources.resolveExport(identity, "/export/code/report name.txt"),
      "https://singularity.invalid",
    );

    expect(resolved.pathname).toBe(
      "/api/v1/organizations/11111111-1111-4111-8111-111111111111/spaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/exports/code/report%20name.txt",
    );
    expect(Object.fromEntries(resolved.searchParams)).toEqual({
      documentId: "20260718000100-docum01",
      download: "true",
      notebookId: "20260718000000-noteb01",
    });
  });

  it("rejects export paths outside the Kernel export namespace", () => {
    const resources = createSpaceGatewayResourcePort(space);

    expect(() => resources.resolveExport(identity, "code/report.txt")).toThrowError(
      /must start with \/export\//,
    );
  });

  it("preserves the URI parsing stack for a malformed encoded resource path", () => {
    const loggedErrors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((label, _context, error) => {
      if (label === "[protyle.gateway]") {
        loggedErrors.push(error);
      }
    });
    const resources = createSpaceGatewayResourcePort(space);

    let thrown: unknown;
    try {
      resources.resolveAsset(identity, "assets/%");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(loggedErrors[0]);
    expect(loggedErrors[0]).toBeInstanceOf(URIError);
    expect((loggedErrors[0] as Error).stack).toContain(
      (loggedErrors[0] as Error).message,
    );
  });
});
