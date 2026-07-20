import type { SpaceRuntimeBootstrap } from "@singularity/contracts";
import type {
  ProtyleHostDispatchEvent,
  ProtyleRuntimeErrorEvent,
  ProtyleSession,
} from "@singularity/protyle-browser";
import {
  type ReactNode,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { getOrFetchCsrfToken } from "@/auth/api.ts";
import {
  activateContentSelectionScope,
  clearContentSelection,
  freezeContentSelectionScope,
  isContentSelectionScopeActive,
  releaseContentSelectionScope,
  selectContentDocument,
  useContentSelectionStore,
  type ContentSelectionScope,
  type ContentSelectionTarget,
} from "@/spaces/content-selection.ts";
import {
  createSpaceProtyleSession,
  type ReadySpaceRuntimeBootstrap,
  type SpaceProtyleMenuSurfaceFactory,
  type SpaceProtyleRuntime,
  type SpaceSessionComposition,
  type SpaceSessionTerminalEvent,
} from "@/spaces/space-session.ts";

export type RuntimeErrorEvent = ProtyleRuntimeErrorEvent;
export type ProtyleMediatorEvent = Exclude<
  ProtyleHostDispatchEvent,
  ProtyleRuntimeErrorEvent
>;
type SessionPhase = "blocked" | "creating" | "disposing" | "idle" | "ready";

interface OwnedSession {
  readonly generation: number;
  readonly requestTerminal: (
    event: SpaceSessionTerminalEvent,
  ) => Promise<boolean>;
  readonly scope: ContentSelectionScope;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
}

interface TerminalTransition {
  readonly promise: Promise<boolean>;
  readonly scope: ContentSelectionScope;
}

/** 通过当前组合根引用转发终止请求，避免渲染阶段直接读取可变 Session。 */
function requestOwnedSessionTerminal(
  activeSessionRef: { readonly current: OwnedSession | null },
  scope: ContentSelectionScope,
  event: SpaceSessionTerminalEvent,
): Promise<boolean> {
  const owned = activeSessionRef.current;
  return owned?.scope === scope
    ? owned.requestTerminal(event)
    : Promise.resolve(false);
}

type RuntimeCorrelation = Pick<
  ProtyleRuntimeErrorEvent,
  "documentId" | "triggeringRequestId"
>;

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

/** 冻结 Transport 后等待真实 Protyle dispose，并无条件清空 portal DOM。 */
async function disposeOwnedSession(
  owned: OwnedSession,
  portalRoot: HTMLElement,
  correlation?: RuntimeCorrelation,
): Promise<void> {
  owned.session.runtime.transport.freeze();
  try {
    await owned.session.dispose();
    console.info("[protyle.lifecycle]", {
      generation: owned.generation,
      phase: "dispose",
      result: "completed",
      spaceId: owned.session.spaceId,
      ...(correlation?.documentId ? { documentId: correlation.documentId } : {}),
      ...(correlation?.triggeringRequestId
        ? { triggeringRequestId: correlation.triggeringRequestId }
        : {}),
    });
  } catch (error) {
    console.error("[protyle.lifecycle]", {
      error,
      generation: owned.generation,
      phase: "dispose",
      result: "failed",
      spaceId: owned.session.spaceId,
      ...(correlation?.documentId ? { documentId: correlation.documentId } : {}),
      ...(correlation?.triggeringRequestId
        ? { triggeringRequestId: correlation.triggeringRequestId }
        : {}),
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

/** 判断运行时错误是否需要终止当前 Session，非终止错误只阻断写入而不清理空间。 */
function isTerminalRuntimeError(
  event: ProtyleRuntimeErrorEvent,
): event is SpaceSessionTerminalEvent {
  return event.category === "unauthenticated" || event.category === "forbidden";
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
  const onAccessLostCurrent = useEffectEvent(onAccessLost);
  const onHostEventCurrent = useEffectEvent(onHostEvent);
  const portalRootRef = useRef<HTMLDivElement>(null);
  const retryRuntimeCurrent = useEffectEvent(retryRuntime);
  const bootstrapCurrent = useEffectEvent(() => bootstrap);
  const menuSurfaceFactoryCurrent = useEffectEvent(createProtyleMenuSurface);
  const selectionScopeRef = useRef<ContentSelectionScope | null>(null);
  const terminalTransitionRef = useRef<TerminalTransition | null>(null);
  const [renderedSession, setRenderedSession] = useState<
    ProtyleSession<SpaceProtyleRuntime> | null
  >(null);
  const [renderedBootstrap, setRenderedBootstrap] = useState<
    ReadySpaceRuntimeBootstrap | null
  >(null);
  const [selectionScope, setSelectionScope] = useState<ContentSelectionScope | null>(null);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const selection = useContentSelectionStore((state) => state.selection);
  /** 按空间路由代次创建唯一 Session，并在切换、撤权或退出时串行冻结和销毁。 */
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const portalRoot = portalRootRef.current;
    if (!portalRoot) {
      return;
    }

    const targetBootstrap = bootstrapCurrent();
    const generation = ++generationRef.current;
    let cancelled = false;
    let nextScope: ContentSelectionScope | null = null;
    const previousScope = selectionScopeRef.current;
    const previousSession = activeSessionRef.current;
    if (previousScope) {
      freezeContentSelectionScope(previousScope);
    }
    previousSession?.session.runtime.transport.freeze();
    if (mountedRef.current) {
      setPhase(
        previousScope || previousSession
          ? "disposing"
          : targetBootstrap ? "creating" : "idle",
      );
    }

    const clearOwnedRenderState = (
      scope: ContentSelectionScope,
      session: ProtyleSession<SpaceProtyleRuntime> | null,
    ) => {
      if (selectionScopeRef.current === scope) {
        releaseContentSelectionScope(scope);
        selectionScopeRef.current = null;
      }
      if (!mountedRef.current) {
        return;
      }
      setSelectionScope((current) => current === scope ? null : current);
      if (session) {
        setRenderedSession((current) => current === session ? null : current);
      }
      setRenderedBootstrap((current) =>
        current && sameSpace(current, scope) ? null : current
      );
      setPhase("idle");
    };

    const createCurrentSession = async () => {
      if (
        !targetBootstrap ||
        cancelled ||
        generation !== generationRef.current
      ) {
        return;
      }
      const scope = activateContentSelectionScope(targetBootstrap);
      nextScope = scope;
      terminalTransitionRef.current = null;
      selectionScopeRef.current = scope;
      if (mountedRef.current) {
        setRenderedBootstrap(targetBootstrap);
        setSelectionScope(scope);
        setPhase("creating");
      }

      let ownedSession: OwnedSession | null = null;
      /** 只接受当前 scope 的 terminal 请求，完成销毁后才通知上层清理授权状态。 */
      const requestTerminal = (
        event: SpaceSessionTerminalEvent,
      ): Promise<boolean> => {
        const existingTransition = terminalTransitionRef.current;
        if (existingTransition?.scope === scope) {
          return existingTransition.promise;
        }
        const active = activeSessionRef.current;
        const currentBootstrap = bootstrapCurrent();
        if (
          ownedSession === null ||
          active !== ownedSession ||
          active.generation !== generation ||
          active.scope !== scope ||
          generation !== generationRef.current ||
          selectionScopeRef.current !== scope ||
          !currentBootstrap ||
          !sameSpace(currentBootstrap, scope)
        ) {
          console.warn("[protyle.lifecycle]", {
            generation,
            phase: "terminal",
            result: "stale-generation-rejected",
            spaceId: targetBootstrap.spaceId,
            ...(event.documentId ? { documentId: event.documentId } : {}),
            ...(event.triggeringRequestId
              ? { triggeringRequestId: event.triggeringRequestId }
              : {}),
          });
          return Promise.resolve(false);
        }

        ++generationRef.current;
        freezeContentSelectionScope(scope);
        active.session.runtime.transport.freeze();
        if (mountedRef.current) {
          setPhase("disposing");
        }
        const terminalPromise: Promise<boolean> = lifecycleQueueRef.current.then(async () => {
          await disposeOwnedSession(active, portalRoot, event);
          if (activeSessionRef.current === active) {
            activeSessionRef.current = null;
          }
          clearOwnedRenderState(scope, active.session);
          try {
            await onAccessLostCurrent(event, currentBootstrap);
          } catch (error) {
            console.error("[protyle.lifecycle]", {
              error,
              generation,
              phase: "access-loss",
              result: "notification-failed",
              spaceId: targetBootstrap.spaceId,
              ...(event.documentId ? { documentId: event.documentId } : {}),
              ...(event.triggeringRequestId
                ? { triggeringRequestId: event.triggeringRequestId }
                : {}),
            });
          }
          if (terminalTransitionRef.current?.promise === terminalPromise) {
            terminalTransitionRef.current = null;
          }
          return true;
        });
        terminalTransitionRef.current = {
          promise: terminalPromise,
          scope,
        };
        lifecycleQueueRef.current = terminalPromise.then(() => undefined);
        return terminalPromise;
      };

      let session: ProtyleSession<SpaceProtyleRuntime>;
      try {
        session = createSpaceProtyleSession({
          bootstrap: targetBootstrap,
          createProtyleMenuSurface: (options) =>
            menuSurfaceFactoryCurrent(options),
          getCsrfToken: getOrFetchCsrfToken,
          onHostEvent: (event) => {
            const active = activeSessionRef.current;
            const currentBootstrap = bootstrapCurrent();
            if (
              !active ||
              active.generation !== generation ||
              active.scope !== scope ||
              generation !== generationRef.current ||
              selectionScopeRef.current !== scope ||
              !currentBootstrap ||
              !sameSpace(currentBootstrap, scope)
            ) {
              console.warn("[protyle.lifecycle]", {
                generation,
                phase: "host-event",
                result: "stale-generation-rejected",
                spaceId: targetBootstrap.spaceId,
                ...(event.type === "runtime-error" && event.documentId
                  ? { documentId: event.documentId }
                  : {}),
                ...(event.type === "runtime-error" && event.triggeringRequestId
                  ? { triggeringRequestId: event.triggeringRequestId }
                  : {}),
              });
              return;
            }
            if (event.type !== "runtime-error") {
              void Promise.resolve()
                .then(() => onHostEventCurrent(event, currentBootstrap))
                .catch((error: unknown) => {
                  console.error("[protyle.host]", {
                    error,
                    eventType: event.type,
                    generation,
                    phase: "mediator",
                    result: "failed",
                    spaceId: targetBootstrap.spaceId,
                  });
                });
              return;
            }
            if (!isTerminalRuntimeError(event)) {
              if (mountedRef.current) {
                setPhase("blocked");
              }
              return;
            }
            void requestTerminal(event);
          },
          portalRoot,
          retryRuntime: () => retryRuntimeCurrent(),
        });
      } catch (error) {
        clearOwnedRenderState(scope, null);
        throw error;
      }

      const owned = {
        generation,
        requestTerminal,
        scope,
        session,
      };
      ownedSession = owned;
      if (
        cancelled ||
        generation !== generationRef.current ||
        selectionScopeRef.current !== scope
      ) {
        freezeContentSelectionScope(scope);
        await disposeOwnedSession(owned, portalRoot);
        clearOwnedRenderState(scope, session);
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
      .catch((error: unknown) => {
        console.error("[protyle.lifecycle]", {
          error,
          generation,
          phase: "create",
          result: "failed",
          ...(targetBootstrap ? { spaceId: targetBootstrap.spaceId } : {}),
        });
      });

    return () => {
      cancelled = true;
      // 终止当前代次后拒绝所有尚未完成的创建与事件回调。
      if (generationRef.current === generation) {
        // 终止清理必须读取最新代次，不能捕获创建 effect 的旧值。
        // eslint-disable-next-line react-hooks/exhaustive-deps
        ++generationRef.current;
      }
      if (nextScope) {
        freezeContentSelectionScope(nextScope);
      }
      const active = activeSessionRef.current;
      if (active?.generation === generation) {
        active.session.runtime.transport.freeze();
      }
      if (mountedRef.current && (nextScope || active?.generation === generation)) {
        setPhase("disposing");
      }
      lifecycleQueueRef.current = lifecycleQueueRef.current
        .then(async () => {
          const owned = activeSessionRef.current;
          if (owned?.generation === generation) {
            await disposeOwnedSession(owned, portalRoot);
            if (activeSessionRef.current === owned) {
              activeSessionRef.current = null;
            }
            clearOwnedRenderState(owned.scope, owned.session);
            return;
          }
          if (nextScope && selectionScopeRef.current === nextScope) {
            clearOwnedRenderState(nextScope, null);
          }
        })
        .catch((error: unknown) => {
          console.error("[protyle.lifecycle]", {
            error,
            generation,
            phase: "dispose",
            result: "cleanup-failed",
            ...(targetBootstrap ? { spaceId: targetBootstrap.spaceId } : {}),
          });
        });
    };
  }, [bootstrap?.organizationId, bootstrap?.role, bootstrap?.spaceId]);

  const currentScope = selectionScope;
  const currentBootstrap = currentScope && sameSpace(bootstrap, currentScope)
    ? bootstrap
    : renderedBootstrap;
  const session = currentScope && renderedSession ? renderedSession : null;
  const scopedSelection = currentScope &&
    isContentSelectionScopeActive(currentScope)
      ? selection?.spaceId === currentScope.spaceId ? selection : null
      : null;
  const composition = currentBootstrap && currentScope &&
    sameSpace(currentBootstrap, currentScope)
      ? {
          bootstrap: currentBootstrap,
          clearSelection: () => clearContentSelection(currentScope),
          requestTerminal: (event: SpaceSessionTerminalEvent) =>
            requestOwnedSessionTerminal(activeSessionRef, currentScope, event),
          scope: currentScope,
          selection: scopedSelection,
          selectDocument: (target: ContentSelectionTarget) =>
            selectContentDocument(currentScope, target),
          session,
        } satisfies SpaceSessionComposition
      : null;

  return (
    <div
      aria-hidden={phase === "disposing" ? true : undefined}
      className={phase === "disposing" ? "contents invisible pointer-events-none" : "contents"}
      data-space-session-state={phase}
    >
      {/* 组合对象中的终止回调只在事件触发时读取 Session 引用。 */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {children(composition)}
      <div ref={portalRootRef} data-protyle-session-portals />
    </div>
  );
}
