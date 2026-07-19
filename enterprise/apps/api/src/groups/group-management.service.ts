import { Inject, Injectable } from "@nestjs/common";
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
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly organizations: OrganizationManagementService,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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
        throw conflict();
      }
      throw error;
    }
  }

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
          select: { id: true, status: true },
        });
        if (existing === null) {
          throw notFound();
        }
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
          await this.accessChanges.publish(transaction, {
            kind: "close",
            reason: "forbidden",
            requestId,
            selectors: [{ kind: "organization", value: organizationId }],
          });
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
        throw conflict();
      }
      throw error;
    }
  }

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
      await transaction.userGroupMembership.create({
        data: { groupId, organizationId, userId },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId,
        selectors: [
          { kind: "organization", value: organizationId },
          { kind: "user", value: userId },
        ],
      });
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
      const removed = await transaction.userGroupMembership.deleteMany({
        where: { groupId, organizationId, userId },
      });
      if (removed.count > 0) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId,
          selectors: [
            { kind: "organization", value: organizationId },
            { kind: "user", value: userId },
          ],
        });
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
}
