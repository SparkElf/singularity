import type { SpaceRuntimeBootstrap } from "@singularity/contracts";
import type {
  ProtyleHostEvent,
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
  createSpaceProtyleSession,
  type ReadySpaceRuntimeBootstrap,
  type SpaceProtyleRuntime,
} from "@/spaces/space-session.ts";

export type RuntimeErrorEvent = Extract<ProtyleHostEvent, { type: "runtime-error" }>;
export type ProtyleMediatorEvent = Exclude<ProtyleHostEvent, RuntimeErrorEvent>;
type SessionPhase = "blocked" | "creating" | "disposing" | "idle" | "ready";

interface OwnedSession {
  readonly generation: number;
  readonly session: ProtyleSession<SpaceProtyleRuntime>;
}

export interface SpaceSessionRootProps {
  readonly bootstrap: ReadySpaceRuntimeBootstrap | null;
  readonly children: (
    session: ProtyleSession<SpaceProtyleRuntime> | null,
  ) => ReactNode;
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

export function SpaceSessionRoot({
  bootstrap,
  children,
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
  const [renderedSession, setRenderedSession] = useState<
    ProtyleSession<SpaceProtyleRuntime> | null
  >(null);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  onAccessLostRef.current = onAccessLost;
  onHostEventRef.current = onHostEvent;
  retryRuntimeRef.current = retryRuntime;

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

    const targetBootstrap = bootstrap;
    const generation = ++generationRef.current;
    let cancelled = false;
    setPhase(targetBootstrap ? "creating" : "idle");

    const createCurrentSession = async () => {
      const previous = activeSessionRef.current;
      if (previous) {
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
      if (!targetBootstrap) {
        if (mountedRef.current) {
          setPhase("idle");
        }
        return;
      }
      if (cancelled) {
        return;
      }
      if (generation !== generationRef.current) {
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
        getCsrfToken: readSessionCsrfToken,
        onHostEvent: (event) => {
          const active = activeSessionRef.current;
          if (!active || active.generation !== generation) {
            console.warn("[protyle.lifecycle]", {
              generation,
              phase: "host-event",
              result: "stale-generation-rejected",
              spaceId: targetBootstrap.spaceId,
            });
            return;
          }
          if (event.type !== "runtime-error") {
            Promise.resolve(onHostEventRef.current(event, targetBootstrap)).catch((error: unknown) => {
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
            await onAccessLostRef.current(event, targetBootstrap);
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
      const owned = { generation, session };
      if (cancelled || generation !== generationRef.current) {
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
  }, [bootstrap]);

  return (
    <div className="contents" data-space-session-state={phase}>
      {children(renderedSession)}
      <div ref={portalRootRef} data-protyle-session-portals />
    </div>
  );
}
