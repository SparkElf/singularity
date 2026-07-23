import type { SpaceRuntimePathParameters } from "@singularity/contracts";

export interface SpaceDocumentNavigationState {
  readonly openDocument: {
    readonly documentId: string;
    readonly notebookId: string;
  };
}

export const EXPLICIT_SPACE_LIST_STATE = "explicit-space-list";

export function spacePagePath({
  organizationId,
  spaceId,
}: SpaceRuntimePathParameters): string {
  return `/organizations/${encodeURIComponent(organizationId)}/spaces/${encodeURIComponent(spaceId)}`;
}

// 通过显式路由 state 把搜索结果交给空间会话，避免从 DOM 或全局首个响应推断文档身份。
export function spaceDocumentNavigationState(
  target: SpaceDocumentNavigationState["openDocument"],
): SpaceDocumentNavigationState {
  return { openDocument: target };
}

// 历史记录 state 属于真实浏览器边界，只接受完整的笔记本/文档身份，其他状态按普通空间入口处理。
export function readSpaceDocumentNavigationState(
  state: unknown,
): SpaceDocumentNavigationState["openDocument"] | null {
  if (state === null || typeof state !== "object") {
    return null;
  }
  const candidate = (state as { openDocument?: unknown }).openDocument;
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }
  const target = candidate as { documentId?: unknown; notebookId?: unknown };
  return typeof target.documentId === "string" && target.documentId.length > 0 && typeof target.notebookId === "string" && target.notebookId.length > 0
    ? { documentId: target.documentId, notebookId: target.notebookId }
    : null;
}
