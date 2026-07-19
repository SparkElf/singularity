import { describe, expect, test } from "vitest";

import { kernelRoutePolicies } from "@singularity/authorization";
import { KernelRoutePolicyRegistry } from "@singularity/kernel-client";

import {
  DOCUMENT_ID_HEADER,
  KernelGatewayAdmissionError,
  NOTEBOOK_ID_HEADER,
  parseKernelGatewayTarget,
  parseKernelWebSocketTarget,
} from "../src/kernel/gateway-path.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const NOTEBOOK_ID = "20260718010101-abcdefg";
const DOCUMENT_ID = "20260718010102-hijklmn";
const policies = new KernelRoutePolicyRegistry(kernelRoutePolicies);

function gatewayApiUrl(path: string): string {
  return `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/kernel/api${path}`;
}

describe("Kernel Gateway path admission", () => {
  test.each([
    { action: "read", audit: undefined, path: "/api/asset/getImageOCRText" },
    { action: "write", audit: "content.edit", path: "/api/asset/ocr" },
    { action: "write", audit: "content.edit", path: "/api/asset/setImageOCRText" },
    { action: "read", audit: undefined, path: "/api/block/getBlockSiblingID" },
    { action: "read", audit: undefined, path: "/api/block/getUnfoldedParentID" },
    { action: "read", audit: undefined, path: "/api/filetree/getRefCreateSavePath" },
  ] as const)(
    "admits the Protyle call to $path with $action authorization",
    ({ action, audit, path }) => {
      const target = parseKernelGatewayTarget(
        "POST",
        gatewayApiUrl(path),
        {
          [DOCUMENT_ID_HEADER]: DOCUMENT_ID,
          [NOTEBOOK_ID_HEADER]: NOTEBOOK_ID,
        },
        policies,
      );

      expect(target).not.toBeNull();
      expect(target?.policy).toMatchObject({
        action,
        contentMode: "json",
        identity: "content",
        method: "POST",
        path,
      });
      expect(target?.policy.audit).toBe(audit);
      expect(target?.upstreamPath).toBe(path);
      expect(target?.forceDownload).toBe(false);
    },
  );

  test("preserves an explicit asset download decision in the admitted target", () => {
    const target = parseKernelGatewayTarget(
      "GET",
      `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/assets/inline.png?notebookId=${NOTEBOOK_ID}&documentId=${DOCUMENT_ID}&download=true`,
      {},
      policies,
    );

    expect(target).toMatchObject({
      forceDownload: true,
      surface: "asset",
      upstreamPath: `/assets/inline.png?box=${NOTEBOOK_ID}&download=true`,
    });
  });

  test.each([
    `//api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/kernel/ws?notebookId=${NOTEBOOK_ID}&documentId=${DOCUMENT_ID}&type=protyle`,
    `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/kernel%2fws?notebookId=${NOTEBOOK_ID}&documentId=${DOCUMENT_ID}&type=protyle`,
    `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/kernel/%?notebookId=${NOTEBOOK_ID}&documentId=${DOCUMENT_ID}&type=protyle`,
  ])("maps a malformed WebSocket URL to a validation admission error", (url) => {
    try {
      parseKernelWebSocketTarget(url);
      throw new Error("Malformed WebSocket URL was admitted");
    } catch (error) {
      expect(error).toBeInstanceOf(KernelGatewayAdmissionError);
      expect((error as KernelGatewayAdmissionError).status).toBe(400);
    }
  });
});
