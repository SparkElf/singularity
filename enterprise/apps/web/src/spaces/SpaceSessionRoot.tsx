import type { SpaceRuntimeBootstrap } from "@singularity/contracts";
import type {
  ProtyleHostDispatchEvent,
  ProtyleRuntimeErrorEvent,
  ProtyleSession,
} from "@singularity/protyle-browser";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { getCsrfToken } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import {
  activateContentSelectionScope,
  clearContentSelection,
  isContentSelectionScopeActive,
  releaseContentSelectionScope,
  selectContentDocument,
  useContentSelectionStore,
  type ContentSelectionScope,
} from "@/spaces/content-selection.ts";
import {
  createSpaceProtyleSession,
  type ReadySpaceRuntimeBootstrap,
  type SpaceProtyleMenuSurfaceFactory,
  type SpaceProtyleRuntime,
  type SpaceSessionComposition,
} from "@/spaces/space-session.ts";

export type RuntimeErrorEvent = ProtyleRuntimeErrorEvent;
export type ProtyleMediatorEvent = Exclude<
  ProtyleHostDispatchEvent,
  ProtyleRuntimeErrorEvent
>;
type SessionPhase = "blocked" | "creating" | "disposing" | "idle" | "ready";

interface OwnedSession {
  readonly generation: number;
  readonly scope: ContentSelectionScope;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
}

export interface SpaceSessionRootProps {
  readonly bootstrap: ReadySpaceRuntimeBootstrap | null;
  readonly children: (composition: SpaceSessionComposition | null) => ReactNode;
  readonly createProtyleMenuSurface: SpaceProtyleMenuSurfaceFactory;
  readonly onAccessLost: (
    event: RuntimeErrorEvent,
    bootstrap: ReadySpaceRuntimeBootstrap,
  ) => void | Promise<void>;
  readonly onHostEvent: (
    event: ProtyleMediatorEvent,
    bootstrap: ReadySpaceRuntimeBootstrap,
  ) => void | Promise<void>;
  readonly retryRuntime: () => Promise<SpaceRuntimeBootstrap>;
}

async function readSessionCsrfToken(signal: AbortSignal): Promise<string> {
  const storedToken = useCsrfStore.getState().csrfToken;
  if (storedToken) {
    return storedToken;
  }
  const response = await getCsrfToken(signal);
  useCsrfStore.getState().setCsrfToken(response.csrfToken);
  return response.csrfToken;
}

async function disposeOwnedSession(
  owned: OwnedSession,
  portalRoot: HTMLElement,
): Promise<void> {
  owned.session.runtime.transport.freeze();
  try {
    await owned.session.dispose();
    console.info("[protyle.lifecycle]", {
      generation: owned.generation,
      phase: "dispose",
      result: "completed",
      spaceId: owned.session.spaceId,
    });
  } catch {
    console.error("[protyle.lifecycle]", {
      generation: owned.generation,
      phase: "dispose",
      result: "failed",
      spaceId: owned.session.spaceId,
    });
  } finally {
    portalRoot.replaceChildren();
  }
}

function sameSpace(
  first: ReadySpaceRuntimeBootstrap | null,
  second: ContentSelectionScope | null,
): boolean {
  return first !== null && second !== null &&
    first.organizationId === second.organizationId &&
    first.spaceId === second.spaceId;
}

export function SpaceSessionRoot({
  bootstrap,
  children,
  createProtyleMenuSurface,
  onAccessLost,
  onHostEvent,
  retryRuntime,
}: SpaceSessionRootProps) {
  const activeSessionRef = useRef<OwnedSession | null>(null);
  const generationRef = useRef(0);
  const lifecycleQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(false);
  const onAccessLostRef = useRef(onAccessLost);
  const onHostEventRef = useRef(onHostEvent);
  const portalRootRef = useRef<HTMLDivElement>(null);
  const retryRuntimeRef = useRef(retryRuntime);
  const bootstrapRef = useRef<ReadySpaceRuntimeBootstrap | null>(bootstrap);
  const menuSurfaceFactoryRef = useRef(createProtyleMenuSurface);
  const selectionScopeRef = useRef<ContentSelectionScope | null>(null);
  const [renderedSession, setRenderedSession] = useState<
    ProtyleSession<SpaceProtyleRuntime> | null
  >(null);
  const [selectionScope, setSelectionScope] = useState<ContentSelectionScope | null>(null);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const selection = useContentSelectionStore((state) => state.selection);
  onAccessLostRef.current = onAccessLost;
  onHostEventRef.current = onHostEvent;
  retryRuntimeRef.current = retryRuntime;
  bootstrapRef.current = bootstrap;
  menuSurfaceFactoryRef.current = createProtyleMenuSurface;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const portalRoot = portalRootRef.current;
    if (!portalRoot) {
      return;
    }

    const targetBootstrap = bootstrapRef.current;
    const generation = ++generationRef.current;
    const nextScope = targetBootstrap
      ? activateContentSelectionScope(targetBootstrap)
      : null;
    const previousScope = selectionScopeRef.current;
    if (previousScope && previousScope !== nextScope) {
      releaseContentSelectionScope(previousScope);
    }
    selectionScopeRef.current = nextScope;
    if (mountedRef.current) {
      setSelectionScope(nextScope);
      setPhase(targetBootstrap ? "creating" : "idle");
    }
    let cancelled = false;

    const createCurrentSession = async () => {
      const previous = activeSessionRef.current;
      if (previous && previous.scope !== nextScope) {
        activeSessionRef.current = null;
        if (mountedRef.current) {
          setPhase("disposing");
        }
        await disposeOwnedSession(previous, portalRoot);
        if (mountedRef.current) {
          setRenderedSession((current) =>
            current === previous.session ? null : current,
          );
        }
      }
      if (!targetBootstrap || !nextScope) {
        if (mountedRef.current) {
          setPhase("idle");
          setRenderedSession(null);
        }
        return;
      }
      if (cancelled || generation !== generationRef.current) {
        console.warn("[protyle.lifecycle]", {
          generation,
          phase: "create",
          result: "stale-generation-rejected",
          spaceId: targetBootstrap.spaceId,
        });
        return;
      }

      const session = createSpaceProtyleSession({
        bootstrap: targetBootstrap,
        createProtyleMenuSurface: (options) =>
          menuSurfaceFactoryRef.current(options),
        getCsrfToken: readSessionCsrfToken,
        onHostEvent: (event) => {
          const active = activeSessionRef.current;
          const currentBootstrap = bootstrapRef.current;
          if (
            !active ||
            active.generation !== generation ||
            active.scope !== nextScope ||
            !currentBootstrap ||
            !sameSpace(currentBootstrap, nextScope)
          ) {
            console.warn("[protyle.lifecycle]", {
              generation,
              phase: "host-event",
              result: "stale-generation-rejected",
              spaceId: targetBootstrap.spaceId,
            });
            return;
          }
          if (event.type !== "runtime-error") {
            Promise.resolve(onHostEventRef.current(event, currentBootstrap)).catch((error: unknown) => {
              console.error("[protyle.host]", {
                error: error instanceof Error ? error.message : "unknown",
                eventType: event.type,
                generation,
                phase: "mediator",
                result: "failed",
                spaceId: targetBootstrap.spaceId,
              });
            });
            return;
          }
          if (event.category !== "unauthenticated" && event.category !== "forbidden") {
            if (mountedRef.current) {
              setPhase("blocked");
            }
            return;
          }

          ++generationRef.current;
          activeSessionRef.current = null;
          releaseContentSelectionScope(nextScope);
          if (selectionScopeRef.current === nextScope) {
            selectionScopeRef.current = null;
          }
          if (mountedRef.current) {
            setSelectionScope(null);
          }
          active.session.runtime.transport.freeze();
          if (mountedRef.current) {
            setPhase("disposing");
          }
          lifecycleQueueRef.current = lifecycleQueueRef.current.then(async () => {
            await disposeOwnedSession(active, portalRoot);
            if (mountedRef.current) {
              setRenderedSession((current) =>
                current === active.session ? null : current,
              );
            }
            await onAccessLostRef.current(event, currentBootstrap);
          }).catch(() => {
            console.error("[protyle.lifecycle]", {
              generation,
              phase: "access-loss",
              result: "notification-failed",
              spaceId: targetBootstrap.spaceId,
            });
          });
        },
        portalRoot,
        retryRuntime: () => retryRuntimeRef.current(),
      });
      const owned = { generation, scope: nextScope, session };
      if (cancelled || generation !== generationRef.current ||
        selectionScopeRef.current !== nextScope) {
        await disposeOwnedSession(owned, portalRoot);
        if (!cancelled) {
          console.warn("[protyle.lifecycle]", {
            generation,
            phase: "create",
            result: "late-session-rejected",
            spaceId: targetBootstrap.spaceId,
          });
        }
        return;
      }

      activeSessionRef.current = owned;
      if (mountedRef.current) {
        setRenderedSession(session);
        setPhase("ready");
      }
      console.info("[protyle.lifecycle]", {
        generation,
        phase: "create",
        result: "completed",
        spaceId: targetBootstrap.spaceId,
      });
    };

    lifecycleQueueRef.current = lifecycleQueueRef.current
      .then(createCurrentSession)
      .catch(() => {
        console.error("[protyle.lifecycle]", {
          generation,
          phase: "create",
          result: "failed",
        });
      });

    return () => {
      cancelled = true;
      if (generationRef.current === generation) {
        ++generationRef.current;
      }
      if (nextScope) {
        releaseContentSelectionScope(nextScope);
        if (selectionScopeRef.current === nextScope) {
          selectionScopeRef.current = null;
        }
        if (mountedRef.current) {
          setSelectionScope((current) => current === nextScope ? null : current);
        }
      }
      const active = activeSessionRef.current;
      if (!active || active.generation !== generation) {
        return;
      }
      activeSessionRef.current = null;
      active.session.runtime.transport.freeze();
      lifecycleQueueRef.current = lifecycleQueueRef.current.then(async () => {
        await disposeOwnedSession(active, portalRoot);
        if (mountedRef.current) {
          setRenderedSession((current) =>
            current === active.session ? null : current,
          );
        }
      });
    };
  }, [bootstrap?.organizationId, bootstrap?.spaceId]);

  const currentScope = selectionScope;
  const currentBootstrap = bootstrap;
  const owned = activeSessionRef.current;
  const session = currentScope && owned && owned.scope === currentScope &&
    owned.session === renderedSession
    ? renderedSession
    : null;
  const scopedSelection = currentScope &&
    isContentSelectionScopeActive(currentScope)
      ? selection?.spaceId === currentScope.spaceId ? selection : null
      : null;
  const composition = currentBootstrap && currentScope &&
    sameSpace(currentBootstrap, currentScope)
      ? {
          bootstrap: currentBootstrap,
          clearSelection: () => clearContentSelection(currentScope),
          scope: currentScope,
          selection: scopedSelection,
          selectDocument: (target: { readonly documentId: string; readonly notebookId: string }) =>
            selectContentDocument(currentScope, target),
          session,
        } satisfies SpaceSessionComposition
      : null;

  return (
    <div className="contents" data-space-session-state={phase}>
      {children(composition)}
      <div ref={portalRootRef} data-protyle-session-portals />
    </div>
  );
}
