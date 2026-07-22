import { useEffect, useMemo, useRef, useState } from "react";
import { UsersIcon, XCircleIcon } from "lucide-react";
import type {
  CollaborationOperationResult,
  CollaborationWebSocketErrorCode,
  DocumentIdentity,
} from "@singularity/contracts";

import { getCollaborationFeature } from "@/collaboration/api.ts";
import { realtimeSessionStatusVariants } from "@/collaboration/collaboration-variants.ts";
import {
  createRealtimeCollaborationClient,
  useRealtimeSessionStore,
  type RealtimeSessionState,
} from "@/collaboration/realtime-session.ts";
import {
  collaborationBroadcastToProtyleMessage,
  mapProtyleOperation,
} from "@/collaboration/protyle-operations.ts";
import type { SpaceGatewayTransport } from "@/spaces/gateway-transport.ts";
import { Button } from "@/components/ui/button.tsx";

type FeatureState = "loading" | "disabled" | "enabled" | "error";
type FeatureMode = "standard" | "restricted-encrypted";
type FeatureSnapshot = { readonly key: string | null; readonly mode: FeatureMode | null; readonly state: FeatureState };
type SessionView = {
  readonly lastErrorCode: CollaborationWebSocketErrorCode | null;
  readonly lastResult: CollaborationOperationResult | null;
  readonly presenceCount: number;
  readonly state: RealtimeSessionState;
};

function useStableIdentity(identity: DocumentIdentity | null): DocumentIdentity | null {
  const organizationId = identity?.organizationId ?? null;
  const spaceId = identity?.spaceId ?? null;
  const notebookId = identity?.notebookId ?? null;
  const documentId = identity?.documentId ?? null;
  return useMemo(
    () => organizationId === null || spaceId === null || notebookId === null || documentId === null
      ? null
      : { documentId, notebookId, organizationId, spaceId },
    [documentId, notebookId, organizationId, spaceId],
  );
}

function sameIdentity(left: DocumentIdentity | null, right: DocumentIdentity): boolean {
  return left !== null && left.organizationId === right.organizationId &&
    left.spaceId === right.spaceId && left.notebookId === right.notebookId &&
    left.documentId === right.documentId;
}

function sessionLabel(state: RealtimeSessionState): string {
  switch (state) {
    case "connecting":
      return "连接中";
    case "ready":
      return "协作就绪";
    case "reconnecting":
      return "重新连接";
    case "conflict":
      return "存在冲突";
    case "revoked":
      return "权限已撤销";
    case "closed":
      return "协作已关闭";
  }
}

function errorLabel(code: string | null): string | null {
  switch (code) {
    case "unauthenticated":
      return "登录状态已失效";
    case "forbidden":
      return "协作请求被拒绝";
    case "invalid-message":
      return "协作协议无效";
    case "service-unavailable":
      return "协作服务不可用";
    case "encrypted-collaboration-unavailable":
      return "加密库暂不可协作";
    case "collaboration-disabled":
      return "协作未启用";
    case "unsupported-client-version":
      return "客户端版本不兼容";
    case "duplicate-session":
      return "协作会话已存在";
    case "collaboration-capacity-exceeded":
      return "协作连接已达上限";
    default:
      return null;
  }
}

/** 将文档开关和专用 WSS 绑定到同一个四段身份；切换或卸载时销毁旧 socket。 */
export function RealtimeCollaborationHost({
  identity,
  readOnly,
  transport,
}: {
  readonly identity: DocumentIdentity | null;
  readonly readOnly: boolean;
  readonly transport: SpaceGatewayTransport<unknown>;
}) {
  const [feature, setFeature] = useState<FeatureSnapshot>({ key: null, mode: null, state: "disabled" });
  const clientRef = useRef<ReturnType<typeof createRealtimeCollaborationClient> | null>(null);
  const detachTransportRef = useRef<(() => void) | null>(null);
  const clientIdentityKey = identity === null
    ? null
    : `${identity.organizationId}:${identity.spaceId}:${identity.notebookId}:${identity.documentId}`;
  const boundIdentity = useStableIdentity(identity);
  const clientId = useMemo(
    () => clientIdentityKey === null ? null : globalThis.crypto.randomUUID(),
    [clientIdentityKey],
  );
  const session = useRealtimeSessionStore((current): SessionView => {
    if (identity === null || !sameIdentity(current.identity, identity)) {
      return {
        lastErrorCode: null,
        lastResult: null,
        presenceCount: 0,
        state: "closed" satisfies RealtimeSessionState,
      };
    }
    return {
      lastErrorCode: current.lastErrorCode,
      lastResult: current.lastResult,
      presenceCount: current.presence.length,
      state: current.state,
    };
  });

  useEffect(() => {
    const currentIdentity = boundIdentity;
    if (currentIdentity === null || clientId === null) {
      return;
    }
    const abortController = new AbortController();
    const releaseRequirement = transport.requireCollaboration(currentIdentity);
    let requirementReleased = false;
    const releaseCollaborationRequirement = (): void => {
      if (requirementReleased) {
        return;
      }
      requirementReleased = true;
      releaseRequirement();
    };
    let cancelled = false;
    let presenceTimer: ReturnType<typeof setInterval> | undefined;
    useRealtimeSessionStore.getState().resetIfIdentity(currentIdentity);

    void getCollaborationFeature(currentIdentity, abortController.signal).then((feature) => {
      if (cancelled) {
        return;
      }
      const mode = feature.restrictedEncryptedEnabled
        ? "restricted-encrypted"
        : feature.standardEnabled
          ? "standard"
          : null;
      if (mode === null) {
        releaseCollaborationRequirement();
        setFeature({ key: clientIdentityKey, mode: null, state: "disabled" });
        return;
      }
      setFeature({ key: clientIdentityKey, mode, state: "enabled" });
      const client = createRealtimeCollaborationClient({
        capability: readOnly ? "viewer" : "editor",
        clientId,
        featureMode: mode,
        identity: currentIdentity,
      });
      detachTransportRef.current = transport.attachCollaboration({
        client,
        clientId,
        identity: currentIdentity,
        mapBroadcast: (broadcast) => collaborationBroadcastToProtyleMessage(currentIdentity, broadcast),
        mapOperation: (operation) => mapProtyleOperation(operation as Parameters<typeof mapProtyleOperation>[0]),
      });
      clientRef.current = client;
      client.connect();
      presenceTimer = setInterval(() => {
        client.updatePresence(null);
      }, 5_000);
    }).catch((error: unknown) => {
      if (cancelled || abortController.signal.aborted) {
        return;
      }
      console.error("[collaboration.feature]", {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "UnknownError", message: String(error), stack: undefined },
        event: "feature.read",
        identity: currentIdentity,
        outcome: "failed",
      });
      setFeature({ key: clientIdentityKey, mode: null, state: "error" });
    });

    return () => {
      cancelled = true;
      abortController.abort();
      if (presenceTimer !== undefined) {
        clearInterval(presenceTimer);
      }
      releaseCollaborationRequirement();
      clientRef.current?.close();
      clientRef.current = null;
      detachTransportRef.current?.();
      detachTransportRef.current = null;
      useRealtimeSessionStore.getState().resetIfIdentity(currentIdentity);
    };
  }, [boundIdentity, clientId, clientIdentityKey, readOnly, transport]);

  const visibleFeature: FeatureSnapshot = identity === null || feature.key !== clientIdentityKey
    ? { key: clientIdentityKey, mode: null, state: identity === null ? "disabled" as const : "loading" as const }
    : feature;
  if (identity === null || visibleFeature.state === "disabled") {
    return null;
  }
  const label = visibleFeature.state === "loading"
    ? "检查协作"
    : visibleFeature.state === "error"
      ? "协作不可用"
      : errorLabel(session.lastErrorCode) ?? (visibleFeature.mode === "restricted-encrypted" ? "受限协作" : sessionLabel(session.state));
  const status: RealtimeSessionState = visibleFeature.state === "error" ? "closed" : session.state;
  const conflict = session.lastResult?.outcome === "conflict" ? session.lastResult.conflict : null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute right-3 top-3 z-10 flex max-w-[min(22rem,calc(100%-1.5rem))] flex-col items-end gap-2"
      data-collaboration-state={status}
      data-collaboration-mode={visibleFeature.mode ?? undefined}
    >
      <div className="flex items-center gap-2">
        <span className={realtimeSessionStatusVariants({ status })}>{label}</span>
        {session.presenceCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <UsersIcon aria-hidden="true" className="size-3" />
            {session.presenceCount}
          </span>
        ) : null}
      </div>
      {conflict !== null ? (
        <div className="pointer-events-auto w-full rounded-md border border-destructive/30 bg-background/95 p-2 text-xs shadow-sm" role="alert">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-destructive">冲突需要处理</p>
              <p className="text-muted-foreground">{conflict.kind} · {conflict.code}</p>
              <code className="block truncate text-[10px] text-muted-foreground" title={conflict.operationId}>
                {conflict.operationId}
              </code>
            </div>
            <Button
              aria-label="结束冲突协作"
              onClick={() => clientRef.current?.close()}
              size="icon-sm"
              title="结束冲突协作"
              variant="ghost"
            >
              <XCircleIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
