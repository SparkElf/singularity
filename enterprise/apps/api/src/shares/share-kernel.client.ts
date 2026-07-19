import type { IncomingMessage } from "node:http";

import { Injectable } from "@nestjs/common";
import { sharedDocumentPayloadSchema } from "@singularity/contracts";
import { DatabaseRuntime } from "@singularity/database";
import {
  KernelPrivateClient,
  type KernelDeploymentIdentity,
} from "@singularity/kernel-client";

import { serviceUnavailable } from "../problem.js";
import type {
  ShareKernelPort,
  SharedAssetPayload,
  SharedDocumentPayload,
} from "./share.types.js";

const VERIFY_PATH = "/internal/enterprise/share/verify";
const DOCUMENT_PATH = "/internal/enterprise/share/document";
const ASSET_PATH = "/internal/enterprise/share/asset";
const MAX_DOCUMENT_RESPONSE_BYTES = 16 * 1_024 * 1_024;

function stringHeader(
  message: IncomingMessage,
  name: string,
): string | undefined {
  const value = message.headers[name];
  return typeof value === "string" ? value : undefined;
}

async function readJson(message: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of message) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > MAX_DOCUMENT_RESPONSE_BYTES) {
      message.destroy();
      throw serviceUnavailable();
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw serviceUnavailable();
  }
}

function sharedDocument(
  value: unknown,
  expectedDocumentId: string,
): SharedDocumentPayload {
  const parsed = sharedDocumentPayloadSchema.safeParse(value);
  if (!parsed.success || parsed.data.documentId !== expectedDocumentId) {
    throw serviceUnavailable();
  }
  return parsed.data;
}

@Injectable()
export class ShareKernelClient implements ShareKernelPort {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly kernel: KernelPrivateClient,
  ) {}

  async verifyDocument(input: {
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<boolean> {
    const response = await this.#request(input, "POST", VERIFY_PATH);
    response.message.resume();
    if (response.status === 200) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    throw serviceUnavailable();
  }

  async readDocument(input: {
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<SharedDocumentPayload | null> {
    const response = await this.#request(input, "POST", DOCUMENT_PATH);
    if (response.status === 404) {
      response.message.resume();
      return null;
    }
    if (response.status !== 200) {
      response.message.resume();
      throw serviceUnavailable();
    }
    return sharedDocument(await readJson(response.message), input.documentId);
  }

  async readAsset(input: {
    assetId: string;
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<SharedAssetPayload | null> {
    const response = await this.#request(
      input,
      "GET",
      `${ASSET_PATH}?assetId=${encodeURIComponent(input.assetId)}`,
    );
    if (response.status === 404) {
      response.message.resume();
      return null;
    }
    const contentLength = stringHeader(response.message, "content-length");
    const disposition = stringHeader(
      response.message,
      "x-singularity-asset-disposition",
    );
    const encodedFileName = stringHeader(
      response.message,
      "x-singularity-asset-filename",
    );
    const mediaType = stringHeader(response.message, "content-type");
    const sizeBytes = contentLength === undefined ? Number.NaN : Number(contentLength);
    if (
      response.status !== 200 ||
      (disposition !== "attachment" && disposition !== "inline") ||
      encodedFileName === undefined ||
      mediaType === undefined ||
      mediaType.trim().length === 0 ||
      /[\r\n]/.test(mediaType) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      response.message.resume();
      throw serviceUnavailable();
    }
    let fileName: string;
    try {
      const decoded = Buffer.from(encodedFileName, "base64url");
      if (
        decoded.byteLength === 0 ||
        decoded.toString("base64url") !== encodedFileName
      ) {
        throw new Error("Asset filename encoding is invalid");
      }
      fileName = decoded.toString("utf8");
    } catch {
      response.message.resume();
      throw serviceUnavailable();
    }
    if (
      fileName.trim().length === 0 ||
      fileName.includes("/") ||
      fileName.includes("\\") ||
      [...fileName].some((character) => character.charCodeAt(0) < 0x20)
    ) {
      response.message.resume();
      throw serviceUnavailable();
    }
    return {
      body: response.message,
      disposition,
      fileName,
      mediaType,
      sizeBytes,
    };
  }

  async #request(
    input: {
      documentId: string;
      notebookId: string;
      organizationId: string;
      requestId: string;
      spaceId: string;
    },
    method: string,
    path: string,
  ) {
    const deployment = await this.#deployment(input);
    return this.kernel.request({
      contentIdentity: {
        documentId: input.documentId,
        notebookId: input.notebookId,
      },
      deployment,
      headers: {},
      method,
      path,
      requestId: input.requestId,
    });
  }

  async #deployment(input: {
    organizationId: string;
    spaceId: string;
  }): Promise<KernelDeploymentIdentity> {
    const instance = await this.database.client.kernelInstance.findFirst({
      where: {
        spaceId: input.spaceId,
        status: "ready",
        space: {
          id: input.spaceId,
          organizationId: input.organizationId,
          status: "active",
          organization: { id: input.organizationId, status: "active" },
        },
      },
      select: { deploymentHandle: true, id: true },
    });
    if (
      instance === null ||
      instance === undefined ||
      instance.deploymentHandle === null
    ) {
      throw serviceUnavailable();
    }
    return {
      handle: instance.deploymentHandle,
      kernelInstanceId: instance.id,
      spaceId: input.spaceId,
    };
  }
}
