import type { Readable } from "node:stream";
import type {
  ManagedDocumentShare,
  SharedAssetDescriptor,
  SharedDocumentPayload,
} from "@singularity/contracts";

export type {
  ManagedDocumentShare,
  SharedAssetDescriptor,
  SharedDocumentPayload,
};

export interface SharedAssetPayload {
  body: Readable;
  disposition: "attachment" | "inline";
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}

export interface ShareKernelPort {
  readAsset(input: {
    assetId: string;
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<SharedAssetPayload | null>;
  readDocument(input: {
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<SharedDocumentPayload | null>;
  verifyDocument(input: {
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<boolean>;
}

export const SHARE_KERNEL = Symbol("SHARE_KERNEL");
