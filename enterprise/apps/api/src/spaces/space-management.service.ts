import { Inject, Injectable } from "@nestjs/common";
import type {
  ManagedSpaceSummary,
  SpaceGroupGrantSummary,
  SpaceGroupCandidatesResponse,
  SpaceMemberCandidatesResponse,
  SpaceMemberSummary,
  SpaceRole,
  UpdateSpaceRequest,
} from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import { unactivatedSpaceRestorePersistenceStatuses } from "../backups/restore-status.persistence.js";
import type { Clock } from "../identity/clock.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { OrganizationManagementService } from "../organizations/organization-management.service.js";
import { conflict, forbidden, notFound } from "../problem.js";
import { CLOCK } from "../tokens.js";
import { SpaceAccessService } from "./space-access.service.js";

type Transaction = Prisma.TransactionClient;

interface SpaceManagerOptions {
  readonly allowRestoreTarget?: boolean;
}

@Injectable()
export class SpaceManagementService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly organizations: OrganizationManagementService,
    private readonly spaceAccess: SpaceAccessService,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 列出当前组织中操作者可见的空间及其角色摘要。 */
  async listSpaces(
    actorUserId: string,
    organizationId: string,
  ): Promise<ManagedSpaceSummary[]> {
    return this.database.client.$transaction(
      async (transaction) => {
        const membership = await transaction.organizationMembership.findFirst({
          where: {
            organizationId,
            status: "active",
            userId: actorUserId,
            user: { status: "active" },
            organization: { status: "active" },
          },
          select: { role: true },
        });
        if (membership === null) {
          throw notFound();
        }
        if (membership.role === "member") {
          throw forbidden();
        }
        const spaces = await transaction.space.findMany({
          where: {
            organizationId,
            targetRestores: {
              none: {
                status: { in: [...unactivatedSpaceRestorePersistenceStatuses] },
              },
            },
          },
          select: { id: true, name: true, organizationId: true, status: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });
        return spaces.map((space) => ({
          organizationId: space.organizationId,
          spaceId: space.id,
          spaceName: space.name,
          status: space.status,
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** 创建空间、Kernel 实例和初始成员关系，并发布部署同步事件。 */
  async createSpace(
    actorUserId: string,
    organizationId: string,
    name: string,
    requestId: string,
  ): Promise<ManagedSpaceSummary> {
    return this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
      );
      const created = await this.spaceAccess.createSpaceInTransaction(transaction, {
        adminUserId: actorUserId,
        name,
        organizationId,
      });
      if (typeof created === "string") {
        throw created === "not-found" ? notFound() : conflict();
      }
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId: created.spaceId,
        targetId: created.spaceId,
        targetType: "space",
      });
      return {
        organizationId,
        spaceId: created.spaceId,
        spaceName: name,
        status: "active",
      };
    });
  }

  /** 返回单个空间的管理视图，所有字段先经过组织和空间归属过滤。 */
  async getSpace(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<ManagedSpaceSummary> {
    const space = await this.database.client.space.findFirst({
      where: {
        id: spaceId,
        organizationId,
        organization: { status: "active" },
        status: { in: ["active", "archived"] },
        targetRestores: {
          none: {
            status: { in: [...unactivatedSpaceRestorePersistenceStatuses] },
          },
        },
      },
      select: {
        id: true,
        name: true,
        organizationId: true,
        status: true,
        organization: {
          select: {
            memberships: {
              where: {
                status: "active",
                userId: actorUserId,
                user: { status: "active" },
              },
              select: { role: true },
              take: 1,
            },
          },
        },
        memberships: {
          where: {
            status: "active",
            userId: actorUserId,
            organizationMembership: {
              status: "active",
              user: { status: "active" },
            },
          },
          select: { role: true },
        },
        groupGrants: {
          where: {
            group: {
              status: "active",
              memberships: {
                some: {
                  organizationId,
                  userId: actorUserId,
                  organizationMembership: {
                    status: "active",
                    user: { status: "active" },
                  },
                },
              },
            },
          },
          select: { role: true },
        },
      },
    });
    if (space === null) {
      throw notFound();
    }
    const organizationRole = space.organization.memberships[0]?.role;
    const delegatedRoles = [
      ...space.memberships.map(({ role }) => role),
      ...space.groupGrants.map(({ role }) => role),
    ];
    if (
      organizationRole !== "owner" &&
      organizationRole !== "admin" &&
      delegatedRoles.length === 0
    ) {
      throw notFound();
    }
    if (
      organizationRole !== "owner" &&
      organizationRole !== "admin" &&
      !delegatedRoles.includes("admin")
    ) {
      throw forbidden();
    }
    return {
      organizationId: space.organizationId,
      spaceId: space.id,
      spaceName: space.name,
      status: space.status,
    };
  }

  /** 更新空间元数据或状态，并在影响内容访问时触发连接重新校验。 */
  async updateSpace(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    update: UpdateSpaceRequest,
    requestId: string,
  ): Promise<ManagedSpaceSummary> {
    return this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "spaces" WHERE "id" = ${spaceId} AND "organization_id" = ${organizationId} FOR UPDATE`,
      );
      const existing = await transaction.space.findFirst({
        where: { id: spaceId, organizationId },
        select: { id: true, name: true, organizationId: true, status: true },
      });
      if (existing === null) {
        throw notFound();
      }
      if (existing.status === "disabled") {
        throw conflict();
      }
      const restoreTarget = await transaction.spaceRestoreJob.findFirst({
        where: {
          targetSpaceId: spaceId,
          status: { in: [...unactivatedSpaceRestorePersistenceStatuses] },
        },
        select: { id: true },
      });
      if (restoreTarget !== null) {
        throw conflict();
      }
      const requestedName = update.name ?? existing.name;
      const requestedStatus = update.status ?? existing.status;
      if (
        requestedName === existing.name &&
        requestedStatus === existing.status
      ) {
        return {
          organizationId: existing.organizationId,
          spaceId: existing.id,
          spaceName: existing.name,
          status: existing.status,
        };
      }
      const space = await transaction.space.update({
        where: { id: spaceId },
        data: {
          ...(update.name === undefined ? {} : { name: update.name }),
          ...(update.status === undefined ? {} : { status: update.status }),
        },
        select: { id: true, name: true, organizationId: true, status: true },
      });
      if (space.status !== existing.status) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId,
          selectors: [{ kind: "space", value: spaceId }],
        });
      }
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId,
        targetId: spaceId,
        targetType: "space",
      });
      return {
        organizationId: space.organizationId,
        spaceId: space.id,
        spaceName: space.name,
        status: space.status,
      };
    });
  }

  /** 列出空间成员及其组织状态，避免返回不属于当前组织的身份。 */
  async listMembers(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<SpaceMemberSummary[]> {
    await this.requireSpaceManager(actorUserId, organizationId, spaceId);
    const memberships = await this.database.client.spaceMembership.findMany({
      where: { organizationId, spaceId },
      select: {
        role: true,
        status: true,
        organizationMembership: {
          select: { user: { select: { id: true, loginIdentifier: true } } },
        },
      },
      orderBy: [{ userId: "asc" }],
    });
    return memberships.map((membership) => ({
      loginIdentifier:
        membership.organizationMembership.user.loginIdentifier,
      role: membership.role,
      status: membership.status,
      userId: membership.organizationMembership.user.id,
    }));
  }

  async listMemberCandidates(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<SpaceMemberCandidatesResponse["members"]> {
    await this.requireSpaceManager(actorUserId, organizationId, spaceId);
    const memberships = await this.database.client.organizationMembership.findMany({
      where: {
        organizationId,
        status: "active",
        user: { status: "active" },
      },
      select: { user: { select: { id: true, loginIdentifier: true } } },
      orderBy: [{ user: { loginIdentifier: "asc" } }, { userId: "asc" }],
    });
    return memberships.map(({ user }) => ({
      loginIdentifier: user.loginIdentifier,
      userId: user.id,
    }));
  }

  /** 以幂等方式设置空间成员角色或状态，并发布访问变化事件。 */
  async setMember(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    userId: string,
    role: SpaceRole,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.requireSpaceManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        spaceId,
        [userId],
      );
      const existingMemberships = await transaction.$queryRaw<
        Array<{ role: SpaceRole; status: "active" | "inactive" }>
      >(
        Prisma.sql`
          SELECT "role", "status"
          FROM "space_memberships"
          WHERE "organization_id" = ${organizationId}
            AND "space_id" = ${spaceId}
            AND "user_id" = ${userId}
          FOR UPDATE
        `,
      );
      const existingMembership = existingMemberships[0];
      const target = await transaction.organizationMembership.findFirst({
        where: {
          organizationId,
          status: "active",
          userId,
          user: { status: "active" },
        },
        select: { id: true },
      });
      if (target === null) {
        throw notFound();
      }
      if (
        existingMembership?.role === role &&
        existingMembership.status === "active"
      ) {
        return;
      }
      await transaction.spaceMembership.upsert({
        where: { spaceId_userId: { spaceId, userId } },
        create: { organizationId, role, spaceId, status: "active", userId },
        update: { role, status: "active" },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId,
        selectors: [
          { kind: "space", value: spaceId },
          { kind: "user", value: userId },
        ],
      });
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId,
        targetId: userId,
        targetType: "membership",
      });
    });
  }

  /** 删除空间成员关系并撤销其空间连接，阻断权限变更后的迟到请求。 */
  async revokeMember(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    userId: string,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.requireSpaceManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        spaceId,
        [userId],
      );
      const revoked = await transaction.spaceMembership.updateMany({
        where: { organizationId, spaceId, status: "active", userId },
        data: { status: "inactive" },
      });
      if (revoked.count > 0) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId,
          selectors: [
            { kind: "space", value: spaceId },
            { kind: "user", value: userId },
          ],
        });
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: this.clock.now(),
          organizationId,
          requestId,
          spaceId,
          targetId: userId,
          targetType: "membership",
        });
      }
    });
  }

  /** 列出空间的群组授权，返回实际生效角色而非底层关系表。 */
  async listGroupGrants(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<SpaceGroupGrantSummary[]> {
    await this.requireSpaceManager(actorUserId, organizationId, spaceId);
    const grants = await this.database.client.spaceGroupGrant.findMany({
      where: { organizationId, spaceId },
      select: {
        group: { select: { id: true, name: true, status: true } },
        role: true,
      },
      orderBy: [{ group: { name: "asc" } }, { groupId: "asc" }],
    });
    return grants.map((grant) => ({
      groupId: grant.group.id,
      groupName: grant.group.name,
      groupStatus: grant.group.status,
      role: grant.role,
    }));
  }

  async listGroupCandidates(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<SpaceGroupCandidatesResponse["groups"]> {
    await this.requireSpaceManager(actorUserId, organizationId, spaceId);
    const groups = await this.database.client.userGroup.findMany({
      where: { organizationId, status: "active" },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return groups.map((group) => ({
      groupId: group.id,
      groupName: group.name,
      groupStatus: "active" as const,
    }));
  }

  /** 以幂等方式设置群组空间角色，并通知所有受影响的运行时。 */
  async setGroupGrant(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    groupId: string,
    role: SpaceRole,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.requireSpaceManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        spaceId,
      );
      const group = await transaction.userGroup.findFirst({
        where: { id: groupId, organizationId, status: "active" },
        select: { id: true },
      });
      if (group === null) {
        throw notFound();
      }
      const existingGrants = await transaction.$queryRaw<
        Array<{ role: SpaceRole }>
      >(
        Prisma.sql`
          SELECT "role"
          FROM "space_group_grants"
          WHERE "organization_id" = ${organizationId}
            AND "space_id" = ${spaceId}
            AND "group_id" = ${groupId}
          FOR UPDATE
        `,
      );
      if (existingGrants[0]?.role === role) {
        return;
      }
      const affectedUserIds = await this.#activeGroupMemberIds(
        transaction,
        organizationId,
        groupId,
      );
      await transaction.spaceGroupGrant.upsert({
        where: { spaceId_groupId: { groupId, spaceId } },
        create: { groupId, organizationId, role, spaceId },
        update: { role },
      });
      for (const affectedUserId of affectedUserIds) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId,
          selectors: [
            { kind: "space", value: spaceId },
            { kind: "user", value: affectedUserId },
          ],
        });
      }
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId,
        targetId: groupId,
        targetType: "group",
      });
    });
  }

  /** 撤销群组空间授权并使旧连接在下一次访问前失效。 */
  async revokeGroupGrant(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    groupId: string,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.requireSpaceManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        spaceId,
      );
      const affectedUserIds = await this.#activeGroupMemberIds(
        transaction,
        organizationId,
        groupId,
      );
      const revoked = await transaction.spaceGroupGrant.deleteMany({
        where: { groupId, organizationId, spaceId },
      });
      if (revoked.count > 0) {
        for (const affectedUserId of affectedUserIds) {
          await this.accessChanges.publish(transaction, {
            kind: "close",
            reason: "forbidden",
            requestId,
            selectors: [
              { kind: "space", value: spaceId },
              { kind: "user", value: affectedUserId },
            ],
          });
        }
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: this.clock.now(),
          organizationId,
          requestId,
          spaceId,
          targetId: groupId,
          targetType: "group",
        });
      }
    });
  }

  /** 校验操作者具备空间管理员角色，返回带组织归属的空间事实。 */
  async requireSpaceManager(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    options: SpaceManagerOptions = {},
  ): Promise<void> {
    const [space, organizationRole, spaceRole] = await Promise.all([
      this.database.client.space.findFirst({
        where: {
          id: spaceId,
          organizationId,
          organization: { status: "active" },
          status: { in: ["active", "archived"] },
          ...(options.allowRestoreTarget
            ? {}
            : {
                targetRestores: {
                  none: {
                    status: {
                      in: [...unactivatedSpaceRestorePersistenceStatuses],
                    },
                  },
                },
              }),
        },
        select: { id: true },
      }),
      this.database.client.organizationMembership.findFirst({
        where: {
          organizationId,
          role: { in: ["owner", "admin"] },
          status: "active",
          userId: actorUserId,
          user: { status: "active" },
          organization: { status: "active" },
        },
        select: { id: true },
      }),
      this.spaceAccess.getEffectiveRole(
        actorUserId,
        organizationId,
        spaceId,
        true,
      ),
    ]);
    if (space === null) {
      throw notFound();
    }
    if (organizationRole === null && spaceRole === null) {
      throw notFound();
    }
    if (organizationRole === null && spaceRole !== "admin") {
      throw forbidden();
    }
  }

  /** 在事务内锁定空间管理员关系，保证权限判定与空间写入使用同一快照。 */
  async requireSpaceManagerInTransaction(
    transaction: Transaction,
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    relatedUserIds: readonly string[] = [],
    options: SpaceManagerOptions = {},
  ): Promise<void> {
    const userIds = [...new Set([actorUserId, ...relatedUserIds])].sort();
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" IN (${Prisma.join(userIds)}) ORDER BY "id" FOR UPDATE`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization_memberships" WHERE "organization_id" = ${organizationId} AND "user_id" IN (${Prisma.join(userIds)}) ORDER BY "user_id" FOR UPDATE`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "spaces" WHERE "id" = ${spaceId} AND "organization_id" = ${organizationId} FOR UPDATE`,
    );
    const space = await transaction.space.findFirst({
      where: {
        id: spaceId,
        organizationId,
        organization: { status: "active" },
        status: { in: ["active", "archived"] },
        ...(options.allowRestoreTarget
          ? {}
          : {
              targetRestores: {
                none: {
                  status: {
                    in: [...unactivatedSpaceRestorePersistenceStatuses],
                  },
                },
              },
            }),
      },
      select: { id: true },
    });
    if (space === null) {
      throw notFound();
    }
    const organizationManager = await transaction.organizationMembership.findFirst({
      where: {
        organizationId,
        role: { in: ["owner", "admin"] },
        status: "active",
        userId: actorUserId,
        user: { status: "active" },
      },
      select: { id: true },
    });
    if (organizationManager !== null) {
      return;
    }
    const [directMembership, groupGrant] = await Promise.all([
      transaction.spaceMembership.findFirst({
        where: {
          organizationId,
          spaceId,
          status: "active",
          userId: actorUserId,
          organizationMembership: {
            status: "active",
            user: { status: "active" },
          },
        },
        select: { role: true },
      }),
      transaction.spaceGroupGrant.findFirst({
        where: {
          organizationId,
          spaceId,
          group: {
            status: "active",
            memberships: {
              some: {
                organizationId,
                userId: actorUserId,
                organizationMembership: {
                  status: "active",
                  user: { status: "active" },
                },
              },
            },
          },
        },
        orderBy: { role: "asc" },
        select: { role: true },
      }),
    ]);
    if (directMembership === null && groupGrant === null) {
      throw notFound();
    }
    if (
      directMembership?.role !== "admin" &&
      groupGrant?.role !== "admin"
    ) {
      throw forbidden();
    }
  }

  async #activeGroupMemberIds(
    transaction: Transaction,
    organizationId: string,
    groupId: string,
  ): Promise<readonly string[]> {
    const memberships = await transaction.userGroupMembership.findMany({
      where: {
        groupId,
        organizationId,
        group: { status: "active" },
        organizationMembership: {
          status: "active",
          user: { status: "active" },
        },
      },
      orderBy: { userId: "asc" },
      select: { userId: true },
    });
    return memberships.map(({ userId }) => userId);
  }
}
