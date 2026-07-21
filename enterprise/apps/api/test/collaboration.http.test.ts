import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  CSRF_HEADER_NAME,
  DOCUMENT_ACCESS_POLICY_PATH_TEMPLATE,
  DOCUMENT_COMMENT_MENTION_CANDIDATES_PATH_TEMPLATE,
  DOCUMENT_COMMENT_THREADS_PATH_TEMPLATE,
  NOTIFICATION_UNREAD_COUNT_PATH,
  NOTIFICATIONS_PATH,
  apiProblemSchema,
  commentMentionCandidatesResponseSchema,
  commentThreadsResponseSchema,
  documentAccessPolicySchema,
  loginResponseSchema,
  notificationUnreadCountSchema,
  notificationsResponseSchema,
  type AccessOperationResult,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { truncateTestDatabase } from "./support/database.js";
import { startTestApiApplication, TEST_PUBLIC_ORIGIN, type TestApiApplication } from "./support/test-app.js";

const password = "correct horse battery staple";
const notebookId = "20260721090000-bookabc";
const documentId = "20260721090001-docabcd";

function buildPath(template: string, parameters: Record<string, string>): string {
  return Object.entries(parameters).reduce(
    (path, [name, value]) => path.replace(`{${name}}`, encodeURIComponent(value)),
    template,
  );
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (value === undefined) throw new Error("login did not issue a session cookie");
  return value;
}

function createdInstallation(result: AccessOperationResult): {
  organizationId: string;
  spaceId: string;
  userId: string;
} {
  if (
    result.outcome !== "created" ||
    !("organizationId" in result) ||
    !("spaceId" in result) ||
    !("userId" in result)
  ) {
    throw new Error("The initialize operation did not create an installation");
  }
  return result;
}

function createdUserId(result: AccessOperationResult): string {
  if (result.outcome !== "created" || !("userId" in result)) {
    throw new Error("The create-user operation did not create a user");
  }
  return result.userId;
}

describe("L2 collaboration HTTP contracts", () => {
  let api: TestApiApplication;
  let database: DatabaseClient;
  let operations: AccessOperationsService;

  beforeAll(async () => {
    api = await startTestApiApplication();
    database = api.app.get(DatabaseRuntime).client;
    operations = api.app.get(AccessOperationsService);
  });

  afterEach(async () => {
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await api.dispose();
  });

  test("keeps restricted document comments, mention candidates and notifications on one ACL chain", async () => {
    const ownerLogin = `owner-${randomUUID()}@example.test`;
    const initialized = createdInstallation(await operations.execute({
      operation: "initialize",
      loginIdentifier: ownerLogin,
      organizationName: "L2 Org",
      password,
      spaceName: "L2 Space",
    }));
    const memberLogin = `member-${randomUUID()}@example.test`;
    const createdMemberId = createdUserId(await operations.execute({
      loginIdentifier: memberLogin,
      operation: "create-user",
      organizationId: initialized.organizationId,
      password,
    }));
    await operations.execute({
      operation: "set-space-member",
      role: "viewer",
      spaceId: initialized.spaceId,
      userId: createdMemberId,
    });

    const login = async (loginIdentifier: string) => {
      const response = await fetch(`${api.baseUrl}${AUTH_LOGIN_PATH}`, {
        body: JSON.stringify({ loginIdentifier, password }),
        headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
        method: "POST",
      });
      expect(response.status).toBe(200);
      return { cookie: cookie(response), csrfToken: loginResponseSchema.parse(await response.json()).csrfToken };
    };
    const owner = await login(ownerLogin);
    const member = await login(memberLogin);
    const identity = {
      documentId,
      notebookId,
      organizationId: initialized.organizationId,
      spaceId: initialized.spaceId,
    };
    const accessPath = buildPath(DOCUMENT_ACCESS_POLICY_PATH_TEMPLATE, identity);
    const commentsPath = buildPath(DOCUMENT_COMMENT_THREADS_PATH_TEMPLATE, identity);
    const mutation = (user: typeof owner, path: string, body: unknown) =>
      fetch(`${api.baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          [CSRF_HEADER_NAME]: user.csrfToken,
          "Content-Type": "application/json",
          Cookie: user.cookie,
          Origin: TEST_PUBLIC_ORIGIN,
        },
        method: "PATCH",
      });

    const policyResponse = await mutation(owner, accessPath, {
      grants: [{ kind: "user", role: "viewer", userId: createdMemberId }],
      mode: "restricted",
    });
    expect(policyResponse.status).toBe(200);
    expect(documentAccessPolicySchema.parse(await policyResponse.json()).mode).toBe("restricted");

    const memberPolicy = await fetch(`${api.baseUrl}${accessPath}`, { headers: { Cookie: member.cookie } });
    expect(memberPolicy.status).toBe(404);
    expect(apiProblemSchema.parse(await memberPolicy.json()).code).toBe("not-found");

    const mentionPath = `${buildPath(DOCUMENT_COMMENT_MENTION_CANDIDATES_PATH_TEMPLATE, identity)}?query=member`;
    const candidates = await fetch(`${api.baseUrl}${mentionPath}`, { headers: { Cookie: member.cookie } });
    expect(candidates.status).toBe(200);
    expect(commentMentionCandidatesResponseSchema.parse(await candidates.json()).candidates).toHaveLength(1);

    const deniedComment = await fetch(`${api.baseUrl}${commentsPath}`, {
      body: JSON.stringify({ anchorBlockId: null, body: "viewer cannot write", mentionedUserIds: [] }),
      headers: {
        [CSRF_HEADER_NAME]: member.csrfToken,
        "Content-Type": "application/json",
        Cookie: member.cookie,
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(deniedComment.status).toBe(403);

    const createdComment = await fetch(`${api.baseUrl}${commentsPath}`, {
      body: JSON.stringify({ anchorBlockId: null, body: "owner note", mentionedUserIds: [createdMemberId] }),
      headers: {
        [CSRF_HEADER_NAME]: owner.csrfToken,
        "Content-Type": "application/json",
        Cookie: owner.cookie,
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(createdComment.status).toBe(201);

    const secondComment = await fetch(`${api.baseUrl}${commentsPath}`, {
      body: JSON.stringify({ anchorBlockId: null, body: "owner follow-up", mentionedUserIds: [createdMemberId] }),
      headers: {
        [CSRF_HEADER_NAME]: owner.csrfToken,
        "Content-Type": "application/json",
        Cookie: owner.cookie,
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(secondComment.status).toBe(201);

    const visibleThreads = await fetch(`${api.baseUrl}${commentsPath}?limit=50`, { headers: { Cookie: member.cookie } });
    expect(visibleThreads.status).toBe(200);
    expect(commentThreadsResponseSchema.parse(await visibleThreads.json()).threads).toHaveLength(2);

    const unread = await fetch(`${api.baseUrl}${NOTIFICATION_UNREAD_COUNT_PATH}`, { headers: { Cookie: member.cookie } });
    expect(unread.status).toBe(200);
    // ACL 授权本身产生一条 permission-changed，两个提及各产生一条 mention。
    expect(notificationUnreadCountSchema.parse(await unread.json()).unreadCount).toBe(3);

    const firstPageResponse = await fetch(`${api.baseUrl}${NOTIFICATIONS_PATH}?limit=1`, {
      headers: { Cookie: member.cookie },
    });
    expect(firstPageResponse.status).toBe(200);
    const firstPage = notificationsResponseSchema.parse(await firstPageResponse.json());
    expect(firstPage.notifications).toHaveLength(1);
    expect(firstPage.cursor).not.toBeNull();
    const secondPageResponse = await fetch(
      `${api.baseUrl}${NOTIFICATIONS_PATH}?limit=1&cursor=${encodeURIComponent(firstPage.cursor!)}`,
      { headers: { Cookie: member.cookie } },
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = notificationsResponseSchema.parse(await secondPageResponse.json());
    expect(secondPage.notifications).toHaveLength(1);
    expect(secondPage.notifications[0]?.notificationId).not.toBe(firstPage.notifications[0]?.notificationId);
  });
});
