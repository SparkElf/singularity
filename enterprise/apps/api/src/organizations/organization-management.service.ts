import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  CreatedOrganizationInvitation,
  EnterpriseManagementAccessResponse,
  OrganizationManagementCapability,
  OrganizationInvitationSummary,
  OrganizationMemberSummary,
  SpaceManagementCapability,
  UpdateOrganizationMemberRequest,
} from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import { unactivatedSpaceRestorePersistenceStatuses } from "../backups/restore-status.persistence.js";
import type { Clock } from "../identity/clock.js";
import { IdentityService, type LoginResult } from "../identity/identity.service.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { conflict, forbidden, notFound } from "../problem.js";
import { CLOCK } from "../tokens.js";

type Transaction = Prisma.TransactionClient;
type OrganizationManagerRole = "owner" | "admin";

const ORGANIZATION_ADMIN_CAPABILITIES = [
  "members",
  "groups",
  "spaces",
  "audit",
] as const satisfies readonly OrganizationManagementCapability[];
const ORGANIZATION_OWNER_CAPABILITIES = [
  ...ORGANIZATION_ADMIN_CAPABILITIES,
  "oidc",
  "ownership",
] as const satisfies readonly OrganizationManagementCapability[];
const SPACE_ADMIN_CAPABILITIES = [
  "access",
  "shares",
  "audit",
  "backups",
  "observability",
] as const satisfies readonly SpaceManagementCapability[];
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
  readonly #logger = new Logger("OrganizationManagementService");

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly identity: IdentityService,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly audit: AuditWriter,
  ) {}

  /** 返回当前操作者的组织管理能力，权限判断集中在该入口供控制器复用。 */
  async getManagementAccess(
    actorUserId: string,
  ): Promise<EnterpriseManagementAccessResponse> {
    return this.database.client.$transaction(
      async (transaction) => {
        const memberships = await transaction.organizationMembership.findMany({
          where: {
            status: "active",
            userId: actorUserId,
            user: { status: "active" },
            organization: { status: "active" },
          },
          select: {
            role: true,
            organization: { select: { id: true, name: true } },
          },
          orderBy: [
            { organization: { name: "asc" } },
            { organizationId: "asc" },
          ],
        });
        const managerOrganizationIds = memberships
          .filter((membership) => membership.role !== "member")
          .map((membership) => membership.organization.id);
        const memberOrganizationIds = memberships
          .filter((membership) => membership.role === "member")
          .map((membership) => membership.organization.id);
        const administeredSpaces =
          memberships.length === 0
            ? []
            : await transaction.space.findMany({
                where: {
                  status: { in: ["active", "archived"] },
                  targetRestores: {
                    none: {
                      status: {
                        in: [...unactivatedSpaceRestorePersistenceStatuses],
                      },
                    },
                  },
                  OR: [
                    {
                      organizationId: { in: managerOrganizationIds },
                    },
                    {
                      organizationId: { in: memberOrganizationIds },
                      OR: [
                        {
                          memberships: {
                            some: {
                              role: "admin",
                              status: "active",
                              userId: actorUserId,
                              organizationMembership: {
                                status: "active",
                                user: { status: "active" },
                              },
                            },
                          },
                        },
                        {
                          groupGrants: {
                            some: {
                              role: "admin",
                              group: {
                                status: "active",
                                memberships: {
                                  some: {
                                    userId: actorUserId,
                                    organizationMembership: {
                                      status: "active",
                                      user: { status: "active" },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
                select: { id: true, name: true, organizationId: true },
                orderBy: [{ name: "asc" }, { id: "asc" }],
              });
        const spacesByOrganization = new Map<
          string,
          Array<(typeof administeredSpaces)[number]>
        >();
        for (const space of administeredSpaces) {
          const current = spacesByOrganization.get(space.organizationId);
          if (current === undefined) {
            spacesByOrganization.set(space.organizationId, [space]);
          } else {
            current.push(space);
          }
        }

        return {
          organizations: memberships.flatMap((membership) => {
            const organizationManager = membership.role !== "member";
            const spaces =
              spacesByOrganization.get(membership.organization.id) ?? [];
            if (!organizationManager && spaces.length === 0) {
              return [];
            }
            return [
              {
                organizationCapabilities: organizationManager
                  ? [
                      ...(membership.role === "owner"
                        ? ORGANIZATION_OWNER_CAPABILITIES
                        : ORGANIZATION_ADMIN_CAPABILITIES),
                    ]
                  : [],
                organizationId: membership.organization.id,
                organizationName: membership.organization.name,
                spaces: spaces.map((space) => ({
                  capabilities: [...SPACE_ADMIN_CAPABILITIES],
                  spaceId: space.id,
                  spaceName: space.name,
                })),
              },
            ];
          }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** 列出组织成员及其空间角色，结果只包含当前组织可见的身份字段。 */
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
        user: { select: { id: true, loginIdentifier: true, status: true } },
      },
      orderBy: [{ user: { loginIdentifier: "asc" } }, { userId: "asc" }],
    });
    return memberships.map((membership) => ({
      accountStatus: membership.user.status,
      loginIdentifier: membership.user.loginIdentifier,
      role: membership.role,
      status: membership.status,
      userId: membership.user.id,
    }));
  }

  /** 列出组织邀请并投影为管理端摘要，不暴露邀请 token 原文。 */
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

  /** 创建一次性组织邀请并保存 token 摘要，事务内完成角色与审计约束。 */
  async createInvitation(input: {
    actorUserId: string;
    expiresInHours: number;
    loginIdentifier: string;
    organizationId: string;
    requestId: string;
    role: "admin" | "member";
  }): Promise<CreatedOrganizationInvitation> {
    const token = randomBytes(32).toString("base64url");
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
      const replacedInvitations = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "organization_invitations"
          WHERE "organization_id" = ${input.organizationId}
            AND "login_identifier" = ${input.loginIdentifier}
            AND "accepted_at" IS NULL
            AND "revoked_at" IS NULL
          ORDER BY "id"
          FOR UPDATE
        `,
      );
      const now = this.clock.now();
      const expiresAt = new Date(
        now.getTime() + input.expiresInHours * 60 * 60 * 1_000,
      );
      if (replacedInvitations.length > 0) {
        await transaction.organizationInvitation.updateMany({
          where: { id: { in: replacedInvitations.map(({ id }) => id) } },
          data: { revokedAt: now },
        });
        for (const replaced of replacedInvitations) {
          await this.audit.appendPermissionChange(transaction, {
            actorUserId: input.actorUserId,
            occurredAt: now,
            organizationId: input.organizationId,
            requestId: input.requestId,
            spaceId: null,
            targetId: replaced.id,
            targetType: "invitation",
          });
        }
      }
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

  /** 撤销尚未消费的邀请，并保留可检索的审计结果。 */
  async revokeInvitation(
    actorUserId: string,
    organizationId: string,
    invitationId: string,
    requestId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const actorRole = await this.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "organization_invitations" WHERE "id" = ${invitationId} AND "organization_id" = ${organizationId} FOR UPDATE`,
      );
      const now = this.clock.now();
      const invitation = await transaction.organizationInvitation.findFirst({
        where: { id: invitationId, organizationId },
        select: { acceptedAt: true, revokedAt: true, role: true },
      });
      if (invitation === null) {
        throw notFound();
      }
      if (invitation.role === "admin" && actorRole !== "owner") {
        throw forbidden();
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

  /** 消费邀请并激活成员关系，所有权转移与重复消费在同一事务中判定。 */
  async acceptInvitation(
    userId: string,
    invitationToken: string,
    requestId: string,
  ): Promise<void> {
    const invitationReference = await this.findInvitationReference(
      invitationToken,
    );
    if (invitationReference === null) {
      throw notFound();
    }
    await this.database.client.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "organizations" WHERE "id" = ${invitationReference.organizationId} FOR UPDATE`,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "organization_memberships" WHERE "organization_id" = ${invitationReference.organizationId} AND "user_id" = ${userId} FOR UPDATE`,
      );
      const { invitation, now } = await this.lockValidInvitation(
        transaction,
        invitationToken,
      );
      if (invitation.organizationId !== invitationReference.organizationId) {
        throw conflict();
      }
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
    currentTokenValue: string | undefined,
    requestId: string,
  ): Promise<LoginResult> {
    const availableInvitation = await this.findAvailableInvitation(invitationToken);
    if (availableInvitation === null) {
      throw notFound();
    }
    const passwordDigest = await this.identity.hashPassword(password);
    try {
      return await this.identity.issueSessionForCreatedUser({
        currentTokenValue,
        requestId,
        createUser: async (transaction) => {
          await transaction.$queryRaw(
            Prisma.sql`SELECT "id" FROM "organizations" WHERE "id" = ${availableInvitation.organizationId} FOR UPDATE`,
          );
          const { invitation, now } = await this.lockValidInvitation(
            transaction,
            invitationToken,
          );
          if (invitation.organizationId !== availableInvitation.organizationId) {
            throw conflict();
          }
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
          return user.id;
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        this.#logUniqueConflict("accept-local-invitation", error);
        throw conflict({ cause: error });
      }
      throw error;
    }
  }

  /** 更新成员组织角色或状态，并按变更范围撤销其现有会话。 */
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
      const requestedRole = update.role ?? membership.role;
      const requestedStatus = update.status ?? membership.status;
      if (
        requestedRole === membership.role &&
        requestedStatus === membership.status
      ) {
        return {
          accountStatus: membership.user.status,
          loginIdentifier: membership.user.loginIdentifier,
          role: membership.role,
          status: membership.status,
          userId,
        };
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
      const deactivatesMembership =
        membership.status === "active" && requestedStatus === "inactive";
      if (deactivatesMembership) {
        await this.#lockRelatedSpaceMemberships(
          transaction,
          organizationId,
          userId,
        );
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
          user: { select: { id: true, loginIdentifier: true, status: true } },
        },
      });
      if (deactivatesMembership) {
        await transaction.spaceMembership.updateMany({
          where: { organizationId, status: "active", userId },
          data: { status: "inactive" },
        });
      }
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
      return {
        accountStatus: changed.user.status,
        loginIdentifier: changed.user.loginIdentifier,
        role: changed.role,
        status: changed.status,
        userId: changed.user.id,
      };
    });
  }

  /** 在锁定组织与成员关系后完成所有权转移，避免并发管理操作产生双 owner。 */
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

  /** 撤销成员全部会话并发布认证变化事件，使各实例立即停止接受旧 token。 */
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
      const otherActiveMembership =
        await transaction.organizationMembership.findFirst({
          where: {
            organizationId: { not: organizationId },
            status: "active",
            userId: targetUserId,
            organization: { status: "active" },
          },
          select: { id: true },
        });
      if (otherActiveMembership !== null) {
        throw conflict();
      }
      const outcome = await this.identity.revokeUserSessionsInTransaction(
        transaction,
        targetUserId,
        this.clock.now(),
        requestId,
      );
      if (outcome === "revoked") {
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: this.clock.now(),
          organizationId,
          requestId,
          spaceId: null,
          targetId: targetUserId,
          targetType: "session",
        });
      }
    });
  }

  /** 校验操作者具备组织管理角色，并返回后续事务可复用的成员事实。 */
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

  /** 在已有事务中锁定并校验组织管理员，避免权限检查与写入之间出现竞态。 */
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

  private async findInvitationReference(
    invitationToken: string,
  ): Promise<{ organizationId: string } | null> {
    return this.database.client.organizationInvitation.findUnique({
      where: { tokenDigest: organizationInvitationTokenDigest(invitationToken) },
      select: { organizationId: true },
    });
  }

  /** 在 OIDC 回调事务内消费邀请并激活成员，复用同一锁与唯一性合同。 */
  async acceptOidcInvitationInTransaction(
    transaction: Transaction,
    invitationId: string,
    organizationId: string,
    userId: string,
    requestId: string,
  ): Promise<void> {
    const invitationReference = await transaction.organizationInvitation.findUnique({
      where: { id: invitationId },
      select: { organizationId: true },
    });
    if (
      invitationReference === null ||
      invitationReference.organizationId !== organizationId
    ) {
      throw conflict();
    }
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization_memberships" WHERE "organization_id" = ${organizationId} AND "user_id" = ${userId} FOR UPDATE`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization_invitations" WHERE "id" = ${invitationId} FOR UPDATE`,
    );
    const now = this.clock.now();
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

  /** 锁定并读取仍有效的邀请，保证后续消费不会与撤销操作交叉。 */
  async lockValidInvitation(
    transaction: Transaction,
    invitationToken: string,
  ) {
    const tokenDigest = organizationInvitationTokenDigest(invitationToken);
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization_invitations" WHERE "token_digest" = ${tokenDigest} FOR UPDATE`,
    );
    const now = this.clock.now();
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
    return { invitation, now };
  }

  /** 将已锁定邀请转换为活动成员关系，并清理一次性消费状态。 */
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
    const existingMembershipRows = await transaction.$queryRaw<
      Array<{
        role: "owner" | "admin" | "member";
        status: "active" | "inactive";
      }>
    >(
      Prisma.sql`
        SELECT "role", "status"
        FROM "organization_memberships"
        WHERE "organization_id" = ${invitation.organizationId}
          AND "user_id" = ${userId}
        FOR UPDATE
      `,
    );
    const existingMembership = existingMembershipRows[0];
    if (existingMembership?.role === "owner") {
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
    if (
      existingMembership?.status === "active" &&
      existingMembership.role !== invitation.role
    ) {
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId,
        selectors: [
          { kind: "organization", value: invitation.organizationId },
          { kind: "user", value: userId },
        ],
      });
    }
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

  async #lockRelatedSpaceMemberships(
    transaction: Transaction,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT space."id"
        FROM "spaces" AS space
        INNER JOIN "space_memberships" AS membership
          ON membership."space_id" = space."id"
        WHERE membership."organization_id" = ${organizationId}
          AND membership."user_id" = ${userId}
        ORDER BY space."id"
        FOR UPDATE OF space
      `,
    );
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "space_memberships"
        WHERE "organization_id" = ${organizationId}
          AND "user_id" = ${userId}
        ORDER BY "space_id", "id"
        FOR UPDATE
      `,
    );
  }

  #logUniqueConflict(
    operation: string,
    error: Prisma.PrismaClientKnownRequestError,
  ): void {
    this.#logger.warn({
      error,
      event: "organization.management",
      operation,
      outcome: "conflict",
    });
  }
}
