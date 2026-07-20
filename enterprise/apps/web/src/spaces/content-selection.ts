import { create } from "zustand";

import type { SpaceRuntimePathParameters } from "@singularity/contracts";

export interface ContentSelection {
  readonly documentId: string;
  readonly notebookId: string;
  readonly spaceId: string;
  readonly supportsGraph: boolean;
}

export interface ContentSelectionTarget {
  readonly documentId: string;
  readonly notebookId: string;
  readonly supportsGraph: boolean;
}

/** 当前授权空间代次的内存能力；代次不进入选择对象，避免把生命周期元数据伪装成内容身份。 */
export interface ContentSelectionScope extends SpaceRuntimePathParameters {
  readonly generation: number;
}

interface ContentSelectionState {
  readonly selection: ContentSelection | null;
}

let activeScope: ContentSelectionScope | null = null;
let frozenScope: ContentSelectionScope | null = null;
let nextGeneration = 0;

export const useContentSelectionStore = create<ContentSelectionState>(() => ({
  selection: null,
}));

function ownsScope(scope: ContentSelectionScope): boolean {
  return activeScope === scope;
}

/** 激活新的空间代次并清空旧选择，使迟到响应无法写入新空间。 */
export function activateContentSelectionScope(
  identity: SpaceRuntimePathParameters,
): ContentSelectionScope {
  const scope = Object.freeze({
    generation: ++nextGeneration,
    organizationId: identity.organizationId,
    spaceId: identity.spaceId,
  });
  activeScope = scope;
  frozenScope = null;
  useContentSelectionStore.setState({ selection: null });
  return scope;
}

/** 释放当前空间代次；非当前代次的清理请求不会影响活动选择。 */
export function releaseContentSelectionScope(
  scope: ContentSelectionScope,
): boolean {
  if (!ownsScope(scope)) {
    return false;
  }
  activeScope = null;
  frozenScope = null;
  useContentSelectionStore.setState({ selection: null });
  return true;
}

/** 冻结当前代次的写命令，但保留选择供正在销毁的编辑器读取。 */
export function freezeContentSelectionScope(
  scope: ContentSelectionScope,
): boolean {
  if (!ownsScope(scope)) {
    return false;
  }
  frozenScope = scope;
  return true;
}

/** 判断选择作用域是否仍由当前空间拥有，用于拦截迟到异步结果。 */
export function isContentSelectionScopeActive(
  scope: ContentSelectionScope,
): boolean {
  return ownsScope(scope);
}

/** 读取当前空间的选择，只返回带相同 spaceId 的内容身份。 */
export function getContentSelectionForScope(
  scope: ContentSelectionScope,
): ContentSelection | null {
  if (!ownsScope(scope)) {
    return null;
  }
  const selection = useContentSelectionStore.getState().selection;
  return selection?.spaceId === scope.spaceId ? selection : null;
}

/** 清除当前代次的选择；冻结代次保留选择供编辑器完成关闭流程。 */
export function clearContentSelection(
  scope: ContentSelectionScope,
): boolean {
  if (!ownsScope(scope) || frozenScope === scope) {
    return false;
  }
  if (useContentSelectionStore.getState().selection !== null) {
    useContentSelectionStore.setState({ selection: null });
  }
  return true;
}

/** 写入带 spaceId、notebookId、documentId 的唯一选择，拒绝旧代次或冻结代次的更新。 */
export function selectContentDocument(
  scope: ContentSelectionScope,
  target: ContentSelectionTarget,
): boolean {
  if (!ownsScope(scope) || frozenScope === scope) {
    console.warn("[content.directory]", {
      documentId: target.documentId,
      generation: scope.generation,
      notebookId: target.notebookId,
      phase: "selection",
      result: ownsScope(scope)
        ? "frozen-generation-rejected"
        : "stale-generation-rejected",
      spaceId: scope.spaceId,
    });
    return false;
  }
  const current = useContentSelectionStore.getState().selection;
  if (
    current?.spaceId === scope.spaceId &&
    current.notebookId === target.notebookId &&
    current.documentId === target.documentId &&
    current.supportsGraph === target.supportsGraph
  ) {
    return true;
  }
  useContentSelectionStore.setState({
    selection: {
      documentId: target.documentId,
      notebookId: target.notebookId,
      spaceId: scope.spaceId,
      supportsGraph: target.supportsGraph,
    },
  });
  return true;
}
