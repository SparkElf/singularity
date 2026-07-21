import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COMMENT_THREAD_OPENAPI_SCHEMA,
  DOCUMENT_ACCESS_POLICY_OPENAPI_SCHEMA,
  DOCUMENT_COMMENT_THREADS_CONTROLLER_PATH,
  DOCUMENT_HISTORY_RESTORE_PATH_TEMPLATE,
  NOTIFICATION_OPENAPI_SCHEMA,
  buildDocumentCommentThreadPath,
  buildDocumentHistoryRestorePath,
  commentThreadSchema,
  documentAccessGrantInputSchema,
  documentIdentitySchema,
  historyVersionSchema,
  notificationSchema,
  restoreHistoryVersionRequestSchema,
  updateDocumentAccessPolicyRequestSchema,
} from "../dist/index.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const document = {
  documentId: "20260721090000-docabcd",
  notebookId: "20260721090001-bookabc",
  organizationId,
  spaceId,
};

describe("L2 content identity and collaboration contracts", () => {
  test("requires the complete four-part document identity", () => {
    assert.equal(documentIdentitySchema.safeParse(document).success, true);
    assert.equal(
      documentIdentitySchema.safeParse({
        ...document,
        documentId: undefined,
      }).success,
      false,
    );
    assert.equal(
      documentIdentitySchema.safeParse({ ...document, currentDocumentId: document.documentId }).success,
      false,
    );
  });

  test("keeps ACL grants discriminated between user and group subjects", () => {
    assert.equal(
      documentAccessGrantInputSchema.safeParse({ kind: "user", role: "editor", userId }).success,
      true,
    );
    assert.equal(
      documentAccessGrantInputSchema.safeParse({ kind: "user", role: "viewer", userId, groupId: userId }).success,
      false,
    );
    assert.equal(
      documentAccessGrantInputSchema.safeParse({ kind: "group", role: "viewer", groupId: userId }).success,
      true,
    );
    assert.equal(
      updateDocumentAccessPolicyRequestSchema.safeParse({
        grants: [
          { kind: "user", role: "viewer", userId },
          { kind: "user", role: "editor", userId },
        ],
        mode: "restricted",
      }).success,
      false,
    );
  });

  test("does not manufacture a block anchor for document comments", () => {
    assert.equal(
      commentThreadSchema.safeParse({
        ...document,
        anchorBlockId: null,
        createdAt: "2026-07-21T09:00:00.000Z",
        createdByUserId: userId,
        resolvedAt: null,
        status: "open",
        threadId,
      }).success,
      true,
    );
    assert.equal(
      commentThreadSchema.safeParse({
        ...document,
        anchorBlockId: "first-block",
        createdAt: "2026-07-21T09:00:00.000Z",
        createdByUserId: userId,
        resolvedAt: null,
        status: "open",
        threadId,
      }).success,
      false,
    );
  });

  test("keeps notification and history responses bound to the document identity", () => {
    assert.equal(
      notificationSchema.safeParse({
        actorUserId: userId,
        createdAt: "2026-07-21T09:00:00.000Z",
        document,
        kind: "mention",
        notificationId: threadId,
        readAt: null,
        threadId,
      }).success,
      true,
    );
    assert.equal(
      historyVersionSchema.safeParse({
        createdAt: "2026-07-21T09:00:00.000Z",
        createdByUserId: null,
        isCurrent: false,
        summary: "历史版本",
        versionId: "aGVsbG8",
      }).success,
      true,
    );
    assert.equal(restoreHistoryVersionRequestSchema.safeParse({ versionId: "aGVsbG8" }).success, true);
  });

  test("builds only explicit document paths and keeps OpenAPI strict", () => {
    assert.equal(
      buildDocumentCommentThreadPath({ ...document, threadId }),
      `${DOCUMENT_COMMENT_THREADS_CONTROLLER_PATH.replace(":organizationId", organizationId).replace(":spaceId", spaceId).replace(":notebookId", document.notebookId).replace(":documentId", document.documentId)}/${threadId}`,
    );
    assert.equal(
      buildDocumentHistoryRestorePath(document),
      DOCUMENT_HISTORY_RESTORE_PATH_TEMPLATE
        .replace("{organizationId}", organizationId)
        .replace("{spaceId}", spaceId)
        .replace("{notebookId}", document.notebookId)
        .replace("{documentId}", document.documentId),
    );
    assert.equal(DOCUMENT_ACCESS_POLICY_OPENAPI_SCHEMA.additionalProperties, false);
    assert.equal(COMMENT_THREAD_OPENAPI_SCHEMA.additionalProperties, false);
    assert.equal(NOTIFICATION_OPENAPI_SCHEMA.additionalProperties, false);
  });
});
