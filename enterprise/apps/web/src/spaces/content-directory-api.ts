import {
  buildContentDirectoryChildDocumentsPath,
  buildContentDirectoryNotebooksPath,
  buildContentDirectoryRootDocumentsPath,
  contentDirectoryDocumentsResponseSchema,
  contentDirectoryNotebooksResponseSchema,
  type ContentDirectoryDocumentsResponse,
  type ContentDirectoryNotebooksResponse,
  type SpaceRuntimePathParameters,
} from "@singularity/contracts";

import { requestJson } from "@/api/http.ts";

export interface ContentDirectoryRootLevel {
  readonly kind: "root";
}

export interface ContentDirectoryChildLevel {
  readonly kind: "children";
  readonly parentDocumentId: string;
}

export type ContentDirectoryLevel =
  | ContentDirectoryRootLevel
  | ContentDirectoryChildLevel;

export interface ContentDirectoryPageIdentity
  extends SpaceRuntimePathParameters {
  readonly level: ContentDirectoryLevel;
  readonly notebookId: string;
}

export function contentDirectorySpaceQueryKey(
  identity: SpaceRuntimePathParameters,
) {
  return [
    "content-directory",
    identity.organizationId,
    identity.spaceId,
  ] as const;
}

export function contentDirectoryNotebooksQueryKey(
  identity: SpaceRuntimePathParameters,
) {
  return [...contentDirectorySpaceQueryKey(identity), "notebooks"] as const;
}

export function contentDirectoryDocumentsQueryKey(
  identity: ContentDirectoryPageIdentity,
  offset: number,
) {
  const prefix = [
    ...contentDirectorySpaceQueryKey(identity),
    "documents",
    identity.notebookId,
  ] as const;
  return identity.level.kind === "root"
    ? [...prefix, "root", offset] as const
    : [
        ...prefix,
        "children",
        identity.level.parentDocumentId,
        offset,
      ] as const;
}

export function getContentDirectoryNotebooks(
  identity: SpaceRuntimePathParameters,
  signal?: AbortSignal,
): Promise<ContentDirectoryNotebooksResponse> {
  return requestJson(
    contentDirectoryNotebooksResponseSchema,
    buildContentDirectoryNotebooksPath(identity),
    { signal: signal ?? null },
  );
}

export function getContentDirectoryDocuments(
  identity: ContentDirectoryPageIdentity,
  offset: number,
  signal?: AbortSignal,
): Promise<ContentDirectoryDocumentsResponse> {
  const path = identity.level.kind === "root"
    ? buildContentDirectoryRootDocumentsPath({
        notebookId: identity.notebookId,
        offset,
        organizationId: identity.organizationId,
        spaceId: identity.spaceId,
      })
    : buildContentDirectoryChildDocumentsPath({
        documentId: identity.level.parentDocumentId,
        notebookId: identity.notebookId,
        offset,
        organizationId: identity.organizationId,
        spaceId: identity.spaceId,
      });
  return requestJson(contentDirectoryDocumentsResponseSchema, path, {
    signal: signal ?? null,
  });
}
