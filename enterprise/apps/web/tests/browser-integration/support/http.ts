import type { Route } from "@playwright/test";

/** 为未覆盖协作交互的浏览器 fixture 提供合法空投影，保持 L2 HTTP 边界可达。 */
export async function fulfillEmptyCollaborationRoute(route: Route): Promise<boolean> {
  const request = route.request();
  if (request.method() !== "GET") {
    return false;
  }
  const url = new URL(request.url());
  const path = url.pathname;
  const identityMatch = path.match(
    /\/organizations\/([^/]+)\/spaces\/([^/]+)\/notebooks\/([^/]+)\/documents\/([^/]+)/,
  );
  const identity = identityMatch === null
    ? null
    : {
        documentId: decodeURIComponent(identityMatch[4]!),
        notebookId: decodeURIComponent(identityMatch[3]!),
        organizationId: decodeURIComponent(identityMatch[1]!),
        spaceId: decodeURIComponent(identityMatch[2]!),
      };
  if (path.endsWith("/comments/mention-candidates")) {
    await fulfillJson(route, { candidates: [] });
    return true;
  }
  if (path.endsWith("/comments")) {
    await fulfillJson(route, { cursor: null, threads: [] });
    return true;
  }
  if (path === "/api/v1/notifications/unread-count") {
    await fulfillJson(route, { unreadCount: 0 });
    return true;
  }
  if (path === "/api/v1/notifications") {
    await fulfillJson(route, { cursor: null, notifications: [] });
    return true;
  }
  if (identity !== null && path.endsWith("/access-policy")) {
    await fulfillJson(route, { ...identity, grants: [], mode: "inherit" });
    return true;
  }
  if (identity !== null && path.endsWith("/history")) {
    await fulfillJson(route, { versions: [] });
    return true;
  }
  if (identity !== null && /\/history\/[^/]+\/diff$/.test(path)) {
    await fulfillJson(route, {
      changes: [],
      document: identity,
      fromVersionId: null,
      toVersionId: "empty",
    });
    return true;
  }
  return false;
}

export async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    status,
  });
}
