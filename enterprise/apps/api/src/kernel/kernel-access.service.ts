import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  type KernelAction,
  type SpaceRole,
  spaceRoleAllowsKernelAction,
} from "@singularity/authorization";
import { DatabaseRuntime } from "@singularity/database";
import type { KernelDeploymentIdentity } from "@singularity/kernel-client";

import type { Clock } from "../identity/clock.js";
import {
  forbidden,
  runtimeAccessLost,
  serviceUnavailable,
} from "../problem.js";
import { CLOCK } from "../tokens.js";

const ROLE_PRIORITY = {
  viewer: 0,
  editor: 1,
  admin: 2,
} as const satisfies Record<SpaceRole, number>;

export interface AuthorizedKernelTarget {
  readonly deployment: KernelDeploymentIdentity;
  readonly role: SpaceRole;
}

export type KernelConnectionAuthorization =
  | {
      readonly expiresAt: Date;
      readonly result: "authorized";
      readonly target: AuthorizedKernelTarget;
    }
  | { readonly result: "unauthenticated" }
  | { readonly result: "forbidden" }
  | { readonly result: "kernel-unavailable" };

interface ResolvedSpaceAccess {
  readonly deploymentHandle: string | null;
  readonly kernelInstanceId: string | null;
  readonly kernelState: "starting" | "ready" | "unavailable" | null;
  readonly role: SpaceRole | null;
}

function strongestRole(roles: readonly SpaceRole[]): SpaceRole | null {
  let strongest: SpaceRole | null = null;
  for (const role of roles) {
    if (strongest === null || ROLE_PRIORITY[role] > ROLE_PRIORITY[strongest]) {
      strongest = role;
    }
  }
  return strongest;
}

@Injectable()
export class KernelAccessService {
  readonly #logger = new Logger("AuthorizationService");

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(CLOCK)
    private readonly clock: Clock,
  ) {}

  /** 校验组织、空间、角色和运行时部署，返回带完整身份的唯一 Kernel 路由目标。 */
  async authorizeHttp(input: {
    action: KernelAction;
    organizationId: string;
    requestId: string;
    spaceId: string;
    userId: string;
  }): Promise<AuthorizedKernelTarget> {
    const access = await this.#resolveSpaceAccess(input);
    if (access === null || access.role === null) {
      this.#logDecision(input, "denied", null);
      throw runtimeAccessLost();
    }
    if (!spaceRoleAllowsKernelAction(access.role, input.action)) {
      this.#logDecision(input, "denied", access.role);
      throw forbidden();
    }
    const target = this.#readyTarget(access, input.spaceId);
    if (target === null) {
      this.#logDecision(input, "kernel-unavailable", access.role);
      throw serviceUnavailable();
    }
    this.#logDecision(input, "allowed", access.role);
    return { deployment: target, role: access.role };
  }

  /** 在 WebSocket 连接存续期间重新校验访问和部署代次，权限变化时立即拒绝旧连接。 */
  async revalidateConnection(input: {
    action: KernelAction;
    authSessionId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
    userId: string;
  }): Promise<KernelConnectionAuthorization> {
    const now = this.clock.now();
    const session = await this.database.client.authSession.findFirst({
      where: {
        absoluteExpiresAt: { gt: now },
        id: input.authSessionId,
        idleExpiresAt: { gt: now },
        revokedAt: null,
        userId: input.userId,
        user: { status: "active" },
      },
      select: { absoluteExpiresAt: true, idleExpiresAt: true },
    });
    if (session === null) {
      this.#logDecision(input, "unauthenticated", null);
      return { result: "unauthenticated" };
    }

    const access = await this.#resolveSpaceAccess(input);
    if (
      access === null ||
      access.role === null ||
      !spaceRoleAllowsKernelAction(access.role, input.action)
    ) {
      this.#logDecision(input, "denied", access?.role ?? null);
      return { result: "forbidden" };
    }
    const deployment = this.#readyTarget(access, input.spaceId);
    if (deployment === null) {
      this.#logDecision(input, "kernel-unavailable", access.role);
      return { result: "kernel-unavailable" };
    }
    this.#logDecision(input, "allowed", access.role);
    return {
      expiresAt:
        session.absoluteExpiresAt < session.idleExpiresAt
          ? session.absoluteExpiresAt
          : session.idleExpiresAt,
      result: "authorized",
      target: { deployment, role: access.role },
    };
  }

  /** 从数据库解析空间访问事实，集中拥有角色合并、状态和组织归属判断。 */
  async #resolveSpaceAccess(input: {
    organizationId: string;
    spaceId: string;
    userId: string;
  }): Promise<ResolvedSpaceAccess | null> {
    const space = await this.database.client.space.findFirst({
      where: {
        id: input.spaceId,
        organizationId: input.organizationId,
        status: "active",
        organization: {
          id: input.organizationId,
          status: "active",
          memberships: {
            some: {
              status: "active",
              userId: input.userId,
              user: { status: "active" },
            },
          },
        },
      },
      select: {
        groupGrants: {
          where: {
            group: {
              status: "active",
              memberships: { some: { userId: input.userId } },
            },
          },
          select: { role: true },
        },
        kernelInstance: {
          select: { deploymentHandle: true, id: true, status: true },
        },
        memberships: {
          where: { status: "active", userId: input.userId },
          select: { role: true },
        },
      },
    });
    if (space === null) {
      return null;
    }
    return {
      deploymentHandle: space.kernelInstance?.deploymentHandle ?? null,
      kernelInstanceId: space.kernelInstance?.id ?? null,
      kernelState: space.kernelInstance?.status ?? null,
      role: strongestRole([
        ...space.memberships.map((membership) => membership.role),
        ...space.groupGrants.map((grant) => grant.role),
      ]),
    };
  }

  #readyTarget(
    access: ResolvedSpaceAccess,
    spaceId: string,
  ): KernelDeploymentIdentity | null {
    if (
      access.kernelState !== "ready" ||
      access.deploymentHandle === null ||
      access.kernelInstanceId === null
    ) {
      return null;
    }
    return {
      handle: access.deploymentHandle,
      kernelInstanceId: access.kernelInstanceId,
      spaceId,
    };
  }

  #logDecision(
    input: {
      action: KernelAction;
      organizationId: string;
      requestId: string;
      spaceId: string;
      userId: string;
    },
    outcome: "allowed" | "denied" | "kernel-unavailable" | "unauthenticated",
    role: SpaceRole | null,
  ): void {
    const context = {
      action: input.action,
      event: "authorization.decision",
      organizationId: input.organizationId,
      outcome,
      requestId: input.requestId,
      ...(role === null ? {} : { role }),
      spaceId: input.spaceId,
      userId: input.userId,
    };
    if (outcome === "allowed") {
      this.#logger.debug(context);
    } else {
      this.#logger.warn(context);
    }
  }
}
