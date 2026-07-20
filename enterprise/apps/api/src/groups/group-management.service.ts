import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  UpdateUserGroupRequest,
  UserGroupMemberSummary,
  UserGroupSummary,
} from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import type { Clock } from "../identity/clock.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { OrganizationManagementService } from "../organizations/organization-management.service.js";
import { conflict, notFound } from "../problem.js";
import { CLOCK } from "../tokens.js";

@Injectable()
export class GroupManagementService {
  readonly #logger = new Logger("GroupManagementService");

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly organizations: OrganizationManagementService,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 查询组织内群组及成员计数，所有结果都受当前操作者的组织身份约束。 */
  async listGroups(
    actorUserId: string,
    organizationId: string,
  ): Promise<UserGroupSummary[]> {
    await this.organizations.requireManager(actorUserId, organizationId);
    const groups = await this.database.client.userGroup.findMany({
      where: { organizationId },
      select: {
        _count: { select: { memberships: true } },
        id: true,
        name: true,
        organizationId: true,
        status: true,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return groups.map((group) => ({
      groupId: group.id,
      memberCount: group._count.memberships,
      name: group.name,
      organizationId: group.organizationId,
      status: group.status,
    }));
  }

  /** 在组织事务中创建群组并记录审计事件，返回可供管理端直接展示的摘要。 */
  async createGroup(
    actorUserId: string,
    organizationId: string,
    name: string,
    requestId: string,
  ): Promise<UserGroupSummary> {
    try {
      return await this.database.client.$transaction(async (transaction) => {
        await this.organizations.requireManagerInTransaction(
          transaction,
          actorUserId,
          organizationId,
        );
        const group = await transaction.userGroup.create({
          data: { name, organizationId, status: "active" },
          select: { id: true, name: true, organizationId: true, status: true },
        });
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: this.clock.now(),
          organizationId,
          requestId,
          spaceId: null,
          targetId: group.id,
          targetType: "group",
        });
        return {
          groupId: group.id,
          memberCount: 0,
          name: group.name,
          organizationId: group.organizationId,
          status: group.status,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        this.#logUniqueConflict("create-group", error);
        throw conflict({ cause: error });
      }
      throw error;
    }
  }

  /** 更新群组名称或状态，并在状态变化后让受影响空间连接重新校验权限。 */
  async updateGroup(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    update: UpdateUserGroupRequest,
    requestId: string,
  ): Promise<UserGroupSummary> {
    try {
      return await this.database.client.$transaction(async (transaction) => {
        await this.organizations.requireManagerInTransaction(
          transaction,
          actorUserId,
          organizationId,
        );
        const existing = await transaction.userGroup.findFirst({
          where: { id: groupId, organizationId },
          select: {
            _count: { select: { memberships: true } },
            id: true,
            name: true,
            organizationId: true,
            status: true,
          },
        });
        if (existing === null) {
          throw notFound();
        }
        const requestedName = update.name ?? existing.name;
        const requestedStatus = update.status ?? existing.status;
        if (
          requestedName === existing.name &&
          requestedStatus === existing.status
        ) {
          return {
            groupId: existing.id,
            memberCount: existing._count.memberships,
            name: existing.name,
            organizationId: existing.organizationId,
            status: existing.status,
          };
        }
        const affectedConnections =
          requestedStatus === existing.status
            ? []
            : await this.#affectedConnections(
                transaction,
                organizationId,
                groupId,
              );
        const group = await transaction.userGroup.update({
          where: { id: groupId },
          data: {
            ...(update.name === undefined ? {} : { name: update.name }),
            ...(update.status === undefined ? {} : { status: update.status }),
          },
          select: {
            _count: { select: { memberships: true } },
            id: true,
            name: true,
            organizationId: true,
            status: true,
          },
        });
        if (group.status !== existing.status) {
          for (const connection of affectedConnections) {
            await this.accessChanges.publish(transaction, {
              kind: "close",
              reason: "forbidden",
              requestId,
              selectors: [
                { kind: "space", value: connection.spaceId },
                { kind: "user", value: connection.userId },
              ],
            });
          }
        }
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: this.clock.now(),
          organizationId,
          requestId,
          spaceId: null,
          targetId: groupId,
          targetType: "group",
        });
        return {
          groupId: group.id,
          memberCount: group._count.memberships,
          name: group.name,
          organizationId: group.organizationId,
          status: group.status,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        this.#logUniqueConflict("update-group", error);
        throw conflict({ cause: error });
      }
      throw error;
    }
  }

  /** 列出群组成员及其组织状态，避免把跨组织用户投影到管理界面。 */
  async listMembers(
    actorUserId: string,
    organizationId: string,
    groupId: string,
  ): Promise<UserGroupMemberSummary[]> {
    await this.organizations.requireManager(actorUserId, organizationId);
    const group = await this.database.client.userGroup.findFirst({
      where: { id: groupId, organizationId },
      select: { id: true },
    });
    if (group === null) {
      throw notFound();
    }
    const memberships = await this.database.client.userGroupMembership.findMany({
      where: { groupId, organizationId },
      select: { user: { select: { id: true, loginIdentifier: true } } },
      orderBy: [{ user: { loginIdentifier: "asc" } }, { userId: "asc" }],
    });
    return memberships.map((membership) => ({
      loginIdentifier: membership.user.loginIdentifier,
      userId: membership.user.id,
    }));
  }

  /** 原子加入群组成员并发布访问变化通知，使空间授权缓存及时失效。 */
  async addMember(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    userId: string,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        false,
        [userId],
      );
      const [group, membership] = await Promise.all([
        transaction.userGroup.findFirst({
          where: { id: groupId, organizationId, status: "active" },
          select: { id: true },
        }),
        transaction.organizationMembership.findFirst({
          where: {
            organizationId,
            status: "active",
            userId,
            user: { status: "active" },
          },
          select: { id: true },
        }),
      ]);
      if (group === null || membership === null) {
        throw notFound();
      }
      const existingMemberships = await transaction.$queryRaw<
        Array<{ id: string }>
      >(
        Prisma.sql`
          SELECT "id"
          FROM "user_group_memberships"
          WHERE "organization_id" = ${organizationId}
            AND "group_id" = ${groupId}
            AND "user_id" = ${userId}
          FOR UPDATE
        `,
      );
      if (existingMemberships.length > 0) {
        return;
      }
      const affectedSpaceIds = await this.#activeGrantedSpaceIds(
        transaction,
        organizationId,
        groupId,
      );
      await transaction.userGroupMembership.create({
        data: { groupId, organizationId, userId },
      });
      for (const spaceId of affectedSpaceIds) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId,
          selectors: [
            { kind: "space", value: spaceId },
            { kind: "user", value: userId },
          ],
        });
      }
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId: null,
        targetId: userId,
        targetType: "membership",
      });
    });
  }

  /** 原子移除群组成员并通知受影响空间，确保迟到请求不能继续使用旧授权。 */
  async removeMember(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    userId: string,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        false,
        [userId],
      );
      const group = await transaction.userGroup.findFirst({
        where: { id: groupId, organizationId },
        select: { id: true },
      });
      if (group === null) {
        throw notFound();
      }
      const affectedSpaceIds = await this.#activeGrantedSpaceIds(
        transaction,
        organizationId,
        groupId,
      );
      const removed = await transaction.userGroupMembership.deleteMany({
        where: { groupId, organizationId, userId },
      });
      if (removed.count > 0) {
        for (const spaceId of affectedSpaceIds) {
          await this.accessChanges.publish(transaction, {
            kind: "close",
            reason: "forbidden",
            requestId,
            selectors: [
              { kind: "space", value: spaceId },
              { kind: "user", value: userId },
            ],
          });
        }
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: this.clock.now(),
          organizationId,
          requestId,
          spaceId: null,
          targetId: userId,
          targetType: "membership",
        });
      }
    });
  }

  /** 计算群组仍能影响的活动空间集合，供访问变化通知使用。 */
  async #activeGrantedSpaceIds(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    groupId: string,
  ): Promise<readonly string[]> {
    const grants = await transaction.spaceGroupGrant.findMany({
      where: {
        groupId,
        organizationId,
        group: { status: "active" },
        space: { status: "active" },
      },
      orderBy: { spaceId: "asc" },
      select: { spaceId: true },
    });
    return grants.map(({ spaceId }) => spaceId);
  }

  /** 读取需要撤销的空间连接身份，返回最小集合而不复制完整权限树。 */
  async #affectedConnections(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    groupId: string,
  ): Promise<readonly { spaceId: string; userId: string }[]> {
    return transaction.$queryRaw<Array<{ spaceId: string; userId: string }>>(
      Prisma.sql`
        SELECT DISTINCT
          space_grant."space_id" AS "spaceId",
          membership."user_id" AS "userId"
        FROM "user_group_memberships" AS membership
        INNER JOIN "organization_memberships" AS organization_membership
          ON organization_membership."organization_id" = membership."organization_id"
          AND organization_membership."user_id" = membership."user_id"
          AND organization_membership."status" = 'active'
        INNER JOIN "users" AS account
          ON account."id" = membership."user_id"
          AND account."status" = 'active'
        INNER JOIN "space_group_grants" AS space_grant
          ON space_grant."organization_id" = membership."organization_id"
          AND space_grant."group_id" = membership."group_id"
        INNER JOIN "spaces" AS space
          ON space."id" = space_grant."space_id"
          AND space."organization_id" = space_grant."organization_id"
          AND space."status" = 'active'
        WHERE membership."organization_id" = ${organizationId}
          AND membership."group_id" = ${groupId}
        ORDER BY "spaceId", "userId"
      `,
    );
  }

  #logUniqueConflict(
    operation: string,
    error: Prisma.PrismaClientKnownRequestError,
  ): void {
    this.#logger.warn({
      error,
      event: "group.management",
      operation,
      outcome: "conflict",
    });
  }
}
