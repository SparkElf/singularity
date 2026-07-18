import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type {
  CreatedOrganizationInvitation,
  OrganizationInvitationSummary,
  OrganizationMemberSummary,
  UpdateOrganizationMemberRequest,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { AuditWriter } from "../audit/audit-writer.service.js";
import type { Clock } from "../identity/clock.js";
import { CLOCK } from "../tokens.js";
import { IdentityService } from "../identity/identity.service.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { conflict, forbidden, notFound } from "../problem.js";

type Transaction = Prisma.TransactionClient;
type OrganizationManagerRole = "owner" | "admin";

const INVITATION_DIGEST_DOMAIN = Buffer.from(
  "singularity.organization-invitation.v1",
  "utf8",
);
const DIGEST_SEPARATOR = Buffer.from([0]);

export function organizationInvitationTokenDigest(token: string): string {
  return createHash("sha256")
    .update(INVITATION_DIGEST_DOMAIN)
    .update(DIGEST_SEPARATOR)
    .update(Buffer.from(token, "base64url"))
    .digest("hex");
}

function invitationSummary(invitation: {
  acceptedAt: Date | null;
  expiresAt: Date;
  id: string;
  loginIdentifier: string;
  organizationId: string;
  revokedAt: Date | null;
  role: "owner" | "admin" | "member";
}): OrganizationInvitationSummary {
  if (invitation.role === "owner") {
    throw new Error("Owner invitations are not part of the public contract");
  }
  return {
    ...(invitation.acceptedAt === null
      ? {}
      : { acceptedAt: invitation.acceptedAt.toISOString() }),
    expiresAt: invitation.expiresAt.toISOString(),
    invitationId: invitation.id,
    loginIdentifier: invitation.loginIdentifier,
    organizationId: invitation.organizationId,
    ...(invitation.revokedAt === null
      ? {}
      : { revokedAt: invitation.revokedAt.toISOString() }),
    role: invitation.role,
  };
}

@Injectable()
export class OrganizationManagementService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly identity: IdentityService,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly audit: AuditWriter,
  ) {}

  async listMembers(
    actorUserId: string,
    organizationId: string,
  ): Promise<OrganizationMemberSummary[]> {
    await this.requireManager(actorUserId, organizationId);
    const memberships = await this.database.client.organizationMembership.findMany({
      where: { organizationId },
      select: {
        role: true,
        status: true,
        user: { select: { id: true, loginIdentifier: true } },
      },
      orderBy: [{ user: { loginIdentifier: "asc" } }, { userId: "asc" }],
    });
    return memberships.map((membership) => ({
      loginIdentifier: membership.user.loginIdentifier,
      role: membership.role,
      status: membership.status,
      userId: membership.user.id,
    }));
  }

  async listInvitations(
    actorUserId: string,
    organizationId: string,
  ): Promise<OrganizationInvitationSummary[]> {
    await this.requireManager(actorUserId, organizationId);
    const invitations = await this.database.client.organizationInvitation.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return invitations.map(invitationSummary);
  }

  async createInvitation(input: {
    actorUserId: string;
    expiresInHours: number;
    loginIdentifier: string;
    organizationId: string;
    requestId: string;
    role: "admin" | "member";
  }): Promise<CreatedOrganizationInvitation> {
    const now = this.clock.now();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      now.getTime() + input.expiresInHours * 60 * 60 * 1_000,
    );
    const invitation = await this.database.client.$transaction(async (transaction) => {
      const actorRole = await this.requireManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
      );
      if (input.role === "admin" && actorRole !== "owner") {
        throw forbidden();
      }
      const existingMembership = await transaction.organizationMembership.findFirst({
        where: {
          organizationId: input.organizationId,
          user: { loginIdentifier: input.loginIdentifier },
        },
        select: { status: true },
      });
      if (existingMembership?.status === "active") {
        throw conflict();
      }
      await transaction.organizationInvitation.updateMany({
        where: {
          acceptedAt: null,
          loginIdentifier: input.loginIdentifier,
          organizationId: input.organizationId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      const created = await transaction.organizationInvitation.create({
        data: {
          expiresAt,
          invitedByUserId: input.actorUserId,
          loginIdentifier: input.loginIdentifier,
          organizationId: input.organizationId,
          role: input.role,
          tokenDigest: organizationInvitationTokenDigest(token),
        },
      });
      await this.audit.appendPermissionChange(transaction, {
        actorUserId: input.actorUserId,
        occurredAt: now,
        organizationId: input.organizationId,
        requestId: input.requestId,
        spaceId: null,
        targetId: created.id,
        targetType: "invitation",
      });
      return created;
    });
    return { ...invitationSummary(invitation), invitationToken: token };
  }

  async revokeInvitation(
    actorUserId: string,
    organizationId: string,
    invitationId: string,
    requestId: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.database.client.$transaction(async (transaction) => {
      await this.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
      );
      const invitation = await transaction.organizationInvitation.findFirst({
        where: { id: invitationId, organizationId },
        select: { acceptedAt: true, revokedAt: true },
      });
      if (invitation === null) {
        throw notFound();
      }
      if (invitation.acceptedAt !== null) {
        throw conflict();
      }
      if (invitation.revokedAt === null) {
        await transaction.organizationInvitation.update({
          where: { id: invitationId },
          data: { revokedAt: now },
        });
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: now,
          organizationId,
          requestId,
          spaceId: null,
          targetId: invitationId,
          targetType: "invitation",
        });
      }
    });
  }

  async acceptInvitation(
    userId: string,
    invitationToken: string,
    requestId: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.database.client.$transaction(async (transaction) => {
      const invitation = await this.lockValidInvitation(
        transaction,
        invitationToken,
        now,
      );
      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { loginIdentifier: true, status: true },
      });
      if (
        user?.status !== "active" ||
        user.loginIdentifier !== invitation.loginIdentifier
      ) {
        throw forbidden();
      }
      await this.activateMembershipForInvitation(
        transaction,
        invitation,
        userId,
        now,
        requestId,
      );
    });
  }

  async acceptLocalInvitation(
    invitationToken: string,
    password: string,
    requestId: string,
  ): Promise<{ userId: string }> {
    const availableInvitation = await this.findAvailableInvitation(invitationToken);
    if (availableInvitation === null) {
      throw notFound();
    }
    const passwordDigest = await this.identity.hashPassword(password);
    const now = this.clock.now();
    try {
      return await this.database.client.$transaction(async (transaction) => {
        const invitation = await this.lockValidInvitation(
          transaction,
          invitationToken,
          now,
        );
        const user = await transaction.user.create({
          data: {
            loginIdentifier: invitation.loginIdentifier,
            passwordDigest,
            status: "active",
          },
          select: { id: true },
        });
        await this.activateMembershipForInvitation(
          transaction,
          invitation,
          user.id,
          now,
          requestId,
        );
        return { userId: user.id };
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

  async updateMember(
    actorUserId: string,
    organizationId: string,
    userId: string,
    update: UpdateOrganizationMemberRequest,
    requestId: string,
  ): Promise<OrganizationMemberSummary> {
    return this.database.client.$transaction(async (transaction) => {
      const actorRole = await this.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        false,
        [userId],
      );
      const membership = await transaction.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: {
          role: true,
          status: true,
          user: { select: { loginIdentifier: true, status: true } },
        },
      });
      if (membership === null) {
        throw notFound();
      }
      if (membership.role === "owner") {
        throw conflict();
      }
      if (
        actorRole !== "owner" &&
        (membership.role === "admin" || update.role === "admin")
      ) {
        throw forbidden();
      }
      if (membership.user.status !== "active" && update.status === "active") {
        throw conflict();
      }
      const changed = await transaction.organizationMembership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: {
          ...(update.role === undefined ? {} : { role: update.role }),
          ...(update.status === undefined ? {} : { status: update.status }),
        },
        select: {
          role: true,
          status: true,
          user: { select: { id: true, loginIdentifier: true } },
        },
      });
      if (changed.status === "inactive") {
        await transaction.spaceMembership.updateMany({
          where: { organizationId, userId },
          data: { status: "inactive" },
        });
      }
      if (
        changed.role !== membership.role ||
        changed.status !== membership.status
      ) {
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
      return {
        loginIdentifier: changed.user.loginIdentifier,
        role: changed.role,
        status: changed.status,
        userId: changed.user.id,
      };
    });
  }

  async transferOwnership(
    actorUserId: string,
    organizationId: string,
    newOwnerUserId: string,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        true,
        [newOwnerUserId],
      );
      if (actorUserId === newOwnerUserId) {
        return;
      }
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "organization_memberships" WHERE "organization_id" = ${organizationId} ORDER BY "user_id" FOR UPDATE`,
      );
      const target = await transaction.organizationMembership.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: newOwnerUserId },
        },
        select: { status: true, user: { select: { status: true } } },
      });
      if (target?.status !== "active" || target.user.status !== "active") {
        throw conflict();
      }
      await transaction.organizationMembership.update({
        where: {
          organizationId_userId: { organizationId, userId: newOwnerUserId },
        },
        data: { role: "owner" },
      });
      await transaction.organizationMembership.update({
        where: {
          organizationId_userId: { organizationId, userId: actorUserId },
        },
        data: { role: "admin" },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId,
        selectors: [
          { kind: "organization", value: organizationId },
          { kind: "user", value: actorUserId },
        ],
      });
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId: null,
        targetId: newOwnerUserId,
        targetType: "membership",
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId,
        selectors: [
          { kind: "organization", value: organizationId },
          { kind: "user", value: newOwnerUserId },
        ],
      });
    });
  }

  async revokeMemberSessions(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const actorRole = await this.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        false,
        [targetUserId],
      );
      const target = await transaction.organizationMembership.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: targetUserId },
        },
        select: { role: true },
      });
      if (target === null) {
        throw notFound();
      }
      if (target.role === "owner" || (target.role === "admin" && actorRole !== "owner")) {
        throw forbidden();
      }
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${targetUserId} FOR UPDATE`,
      );
      await this.identity.revokeUserSessionsInTransaction(
        transaction,
        targetUserId,
        this.clock.now(),
        requestId,
      );
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId: null,
        targetId: targetUserId,
        targetType: "session",
      });
    });
  }

  async requireManager(
    actorUserId: string,
    organizationId: string,
    ownerOnly = false,
  ): Promise<OrganizationManagerRole> {
    const membership = await this.database.client.organizationMembership.findFirst({
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
    if (
      membership.role === "member" ||
      (ownerOnly && membership.role !== "owner")
    ) {
      throw forbidden();
    }
    return membership.role;
  }

  async requireManagerInTransaction(
    transaction: Transaction,
    actorUserId: string,
    organizationId: string,
    ownerOnly = false,
    relatedUserIds: readonly string[] = [],
  ): Promise<OrganizationManagerRole> {
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
    if (
      membership.role === "member" ||
      (ownerOnly && membership.role !== "owner")
    ) {
      throw forbidden();
    }
    return membership.role;
  }

  async findAvailableInvitation(
    invitationToken: string,
  ): Promise<{ id: string; loginIdentifier: string; organizationId: string } | null> {
    const now = this.clock.now();
    return this.database.client.organizationInvitation.findFirst({
      where: {
        acceptedAt: null,
        expiresAt: { gt: now },
        revokedAt: null,
        tokenDigest: organizationInvitationTokenDigest(invitationToken),
        organization: { status: "active" },
      },
      select: { id: true, loginIdentifier: true, organizationId: true },
    });
  }

  async acceptOidcInvitationInTransaction(
    transaction: Transaction,
    invitationId: string,
    userId: string,
    now: Date,
    requestId: string,
  ): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization_invitations" WHERE "id" = ${invitationId} FOR UPDATE`,
    );
    const invitation = await transaction.organizationInvitation.findUnique({
      where: { id: invitationId },
      include: { organization: { select: { status: true } } },
    });
    if (
      invitation === null ||
      invitation.organization.status !== "active" ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= now.getTime()
    ) {
      throw conflict();
    }
    await this.activateMembershipForInvitation(
      transaction,
      invitation,
      userId,
      now,
      requestId,
    );
  }

  async lockValidInvitation(
    transaction: Transaction,
    invitationToken: string,
    now: Date,
  ) {
    const tokenDigest = organizationInvitationTokenDigest(invitationToken);
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization_invitations" WHERE "token_digest" = ${tokenDigest} FOR UPDATE`,
    );
    const invitation = await transaction.organizationInvitation.findUnique({
      where: { tokenDigest },
      include: { organization: { select: { status: true } } },
    });
    if (invitation === null) {
      throw notFound();
    }
    if (
      invitation.organization.status !== "active" ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= now.getTime()
    ) {
      throw conflict();
    }
    return invitation;
  }

  async activateMembershipForInvitation(
    transaction: Transaction,
    invitation: {
      id: string;
      loginIdentifier: string;
      organizationId: string;
      role: "owner" | "admin" | "member";
    },
    userId: string,
    now: Date,
    requestId: string,
  ): Promise<void> {
    if (invitation.role === "owner") {
      throw conflict();
    }
    await transaction.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId,
        },
      },
      create: {
        organizationId: invitation.organizationId,
        role: invitation.role,
        status: "active",
        userId,
      },
      update: { role: invitation.role, status: "active" },
    });
    await transaction.organizationInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: now, acceptedByUserId: userId },
    });
    await this.audit.appendPermissionChange(transaction, {
      actorUserId: userId,
      occurredAt: now,
      organizationId: invitation.organizationId,
      requestId,
      spaceId: null,
      targetId: userId,
      targetType: "membership",
    });
  }
}
