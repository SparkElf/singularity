import { create } from "zustand";
import { useEffect, useState } from "react";

import type { SpaceRuntimePathParameters } from "@singularity/contracts";

export interface ContentSelection {
  readonly documentId: string;
  readonly notebookId: string;
  readonly spaceId: string;
}

export interface ContentSelectionTarget {
  readonly documentId: string;
  readonly notebookId: string;
}

/** 当前授权空间代次的内存能力；代次不进入选择对象，避免把生命周期元数据伪装成内容身份。 */
export interface ContentSelectionScope extends SpaceRuntimePathParameters {
  readonly generation: number;
}

interface ContentSelectionState {
  readonly selection: ContentSelection | null;
}

let activeScope: ContentSelectionScope | null = null;
let nextGeneration = 0;

export const useContentSelectionStore = create<ContentSelectionState>(() => ({
  selection: null,
}));

function ownsScope(scope: ContentSelectionScope): boolean {
  return activeScope === scope;
}

export function activateContentSelectionScope(
  identity: SpaceRuntimePathParameters,
): ContentSelectionScope {
  const scope = Object.freeze({
    generation: ++nextGeneration,
    organizationId: identity.organizationId,
    spaceId: identity.spaceId,
  });
  activeScope = scope;
  useContentSelectionStore.setState({ selection: null });
  return scope;
}

export function releaseContentSelectionScope(
  scope: ContentSelectionScope,
): boolean {
  if (!ownsScope(scope)) {
    return false;
  }
  activeScope = null;
  useContentSelectionStore.setState({ selection: null });
  return true;
}

export function isContentSelectionScopeActive(
  scope: ContentSelectionScope,
): boolean {
  return ownsScope(scope);
}

export function getContentSelectionForScope(
  scope: ContentSelectionScope,
): ContentSelection | null {
  if (!ownsScope(scope)) {
    return null;
  }
  const selection = useContentSelectionStore.getState().selection;
  return selection?.spaceId === scope.spaceId ? selection : null;
}

export function clearContentSelection(
  scope: ContentSelectionScope,
): boolean {
  if (!ownsScope(scope)) {
    return false;
  }
  if (useContentSelectionStore.getState().selection !== null) {
    useContentSelectionStore.setState({ selection: null });
  }
  return true;
}

export function selectContentDocument(
  scope: ContentSelectionScope,
  target: ContentSelectionTarget,
): boolean {
  if (!ownsScope(scope)) {
    console.warn("[content.directory]", {
      documentId: target.documentId,
      generation: scope.generation,
      notebookId: target.notebookId,
      phase: "selection",
      result: "stale-generation-rejected",
      spaceId: scope.spaceId,
    });
    return false;
  }
  const current = useContentSelectionStore.getState().selection;
  if (
    current?.spaceId === scope.spaceId &&
    current.notebookId === target.notebookId &&
    current.documentId === target.documentId
  ) {
    return true;
  }
  useContentSelectionStore.setState({
    selection: {
      documentId: target.documentId,
      notebookId: target.notebookId,
      spaceId: scope.spaceId,
    },
  });
  return true;
}

export function useContentSelectionScope(
  identity: SpaceRuntimePathParameters,
): ContentSelectionScope | null {
  const [scope, setScope] = useState<ContentSelectionScope | null>(null);

  useEffect(() => {
    const nextScope = activateContentSelectionScope(identity);
    setScope(nextScope);
    return () => {
      releaseContentSelectionScope(nextScope);
    };
  }, [identity.organizationId, identity.spaceId]);

  return scope?.organizationId === identity.organizationId &&
    scope.spaceId === identity.spaceId
    ? scope
    : null;
}
