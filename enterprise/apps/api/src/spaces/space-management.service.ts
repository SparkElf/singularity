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
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { AuditWriter } from "../audit/audit-writer.service.js";
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

  async listSpaces(
    actorUserId: string,
    organizationId: string,
  ): Promise<ManagedSpaceSummary[]> {
    await this.organizations.requireManager(actorUserId, organizationId);
    const spaces = await this.database.client.space.findMany({
      where: { organizationId },
      select: { id: true, name: true, organizationId: true, status: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return spaces.map((space) => ({
      organizationId: space.organizationId,
      spaceId: space.id,
      spaceName: space.name,
      status: space.status,
    }));
  }

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

  async getSpace(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<ManagedSpaceSummary> {
    await this.requireSpaceManager(actorUserId, organizationId, spaceId);
    const space = await this.database.client.space.findFirst({
      where: {
        id: spaceId,
        organizationId,
        organization: { status: "active" },
        status: { in: ["active", "archived"] },
      },
      select: { id: true, name: true, organizationId: true, status: true },
    });
    if (space === null) {
      throw notFound();
    }
    return {
      organizationId: space.organizationId,
      spaceId: space.id,
      spaceName: space.name,
      status: space.status,
    };
  }

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
      const existing = await transaction.space.findFirst({
        where: { id: spaceId, organizationId },
        select: { status: true },
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
        where: { organizationId, spaceId, userId },
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
      await transaction.spaceGroupGrant.upsert({
        where: { spaceId_groupId: { groupId, spaceId } },
        create: { groupId, organizationId, role, spaceId },
        update: { role },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId,
        selectors: [{ kind: "space", value: spaceId }],
      });
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
      const revoked = await transaction.spaceGroupGrant.deleteMany({
        where: { groupId, organizationId, spaceId },
      });
      if (revoked.count > 0) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId,
          selectors: [{ kind: "space", value: spaceId }],
        });
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
    const [directAdmin, groupAdmin] = await Promise.all([
      transaction.spaceMembership.findFirst({
        where: {
          organizationId,
          role: "admin",
          spaceId,
          status: "active",
          userId: actorUserId,
          organizationMembership: {
            status: "active",
            user: { status: "active" },
          },
        },
        select: { id: true },
      }),
      transaction.spaceGroupGrant.findFirst({
        where: {
          organizationId,
          role: "admin",
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
        select: { id: true },
      }),
    ]);
    if (directAdmin === null && groupAdmin === null) {
      throw forbidden();
    }
  }
}
