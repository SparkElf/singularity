import { Injectable } from "@nestjs/common";
import type {
  DocumentAccessGrant,
  DocumentAccessPolicy,
  DocumentAccessRole,
  DocumentIdentity,
  UpdateDocumentAccessPolicyRequest,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { AuditWriter } from "@singularity/database";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { writeNotificationsInTransaction } from "../notifications/notification-writer.js";
import { SpaceManagementService } from "../spaces/space-management.service.js";
import { forbidden, notFound } from "../problem.js";

const documentRoleWeight: Record<DocumentAccessRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
};

function strongerRole(
  left: DocumentAccessRole | null,
  right: DocumentAccessRole | null,
): DocumentAccessRole | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return documentRoleWeight[left] >= documentRoleWeight[right] ? left : right;
}

interface DocumentAccessInput extends DocumentIdentity {
  actorUserId: string;
}

export interface DocumentAccessDecision {
  readonly canManage: boolean;
  readonly role: DocumentAccessRole | null;
}

@Injectable()
export class DocumentAccessPolicyService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly spaces: SpaceManagementService,
    private readonly audit: AuditWriter,
  ) {}

  /** 读取文档权限策略；管理面只允许空间管理员查看，避免泄露受限文档的 grant 元数据。 */
  async getPolicy(input: DocumentAccessInput): Promise<DocumentAccessPolicy> {
    return this.database.client.$transaction(async (transaction) => {
      const decision = await this.#decideInTransaction(transaction, input);
      if (!decision.canManage) {
        throw notFound();
      }
      const policy = await transaction.documentAccessPolicy.findUnique({
        where: {
          organizationId_spaceId_notebookId_documentId: {
            documentId: input.documentId,
            notebookId: input.notebookId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
          },
        },
        include: { grants: { orderBy: { createdAt: "asc" } } },
      });
      return policy === null
        ? {
            documentId: input.documentId,
            grants: [],
            mode: "inherit",
            notebookId: input.notebookId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
          }
        : this.#projectPolicy(policy);
    });
  }

  /** 在同一事务替换文档 ACL，并复用统一审计链；受限模式不允许留下隐式旧 grant。 */
  async updatePolicy(input: {
    actorUserId: string;
    identity: DocumentIdentity;
    requestId: string;
    value: UpdateDocumentAccessPolicyRequest;
  }): Promise<DocumentAccessPolicy> {
    return this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.identity.organizationId,
        input.identity.spaceId,
      );
      const policy = await transaction.documentAccessPolicy.upsert({
        where: {
          organizationId_spaceId_notebookId_documentId: {
            documentId: input.identity.documentId,
            notebookId: input.identity.notebookId,
            organizationId: input.identity.organizationId,
            spaceId: input.identity.spaceId,
          },
        },
        create: {
          documentId: input.identity.documentId,
          mode: input.value.mode,
          notebookId: input.identity.notebookId,
          organizationId: input.identity.organizationId,
          spaceId: input.identity.spaceId,
        },
        update: { mode: input.value.mode },
        select: { id: true },
      });
      // 同一文档的 ACL 替换必须串行化，避免并发请求交叉删除或覆盖 grant 集合。
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "document_access_policies" WHERE "id" = ${policy.id}::uuid FOR UPDATE`,
      );
      const userIds = input.value.grants
        .filter((grant): grant is Extract<typeof grant, { kind: "user" }> => grant.kind === "user")
        .map((grant) => grant.userId);
      const groupIds = input.value.grants
        .filter((grant): grant is Extract<typeof grant, { kind: "group" }> => grant.kind === "group")
        .map((grant) => grant.groupId);
      const [members, groups] = await Promise.all([
        transaction.organizationMembership.findMany({
          where: {
            organizationId: input.identity.organizationId,
            status: "active",
            user: { status: "active" },
            userId: { in: [...new Set(userIds)] },
          },
          select: { userId: true },
        }),
        transaction.userGroup.findMany({
          where: {
            id: { in: [...new Set(groupIds)] },
            organizationId: input.identity.organizationId,
            status: "active",
          },
          select: { id: true },
        }),
      ]);
      if (
        members.length !== new Set(userIds).size ||
        groups.length !== new Set(groupIds).size
      ) {
        throw notFound();
      }
      await transaction.documentAccessGrant.deleteMany({
        where: { policyId: policy.id },
      });
      if (input.value.grants.length > 0) {
        await transaction.documentAccessGrant.createMany({
          data: input.value.grants.map((grant) => ({
            documentId: input.identity.documentId,
            groupId: grant.kind === "group" ? grant.groupId : null,
            kind: grant.kind,
            notebookId: input.identity.notebookId,
            organizationId: input.identity.organizationId,
            policyId: policy.id,
            role: grant.role,
            spaceId: input.identity.spaceId,
            userId: grant.kind === "user" ? grant.userId : null,
          })),
        });
      }
      const membersAfterChange = await transaction.organizationMembership.findMany({
        where: {
          organizationId: input.identity.organizationId,
          status: "active",
          user: { status: "active" },
        },
        select: { userId: true },
      });
      const recipients: string[] = [];
      const deniedUserIds: string[] = [];
      for (const member of membersAfterChange) {
        const decision = await this.#decideInTransaction(transaction, {
          actorUserId: member.userId,
          documentId: input.identity.documentId,
          notebookId: input.identity.notebookId,
          organizationId: input.identity.organizationId,
          spaceId: input.identity.spaceId,
        });
        if (decision.role !== null) {
          recipients.push(member.userId);
        } else {
          deniedUserIds.push(member.userId);
        }
      }
      await writeNotificationsInTransaction(transaction, {
        actorUserId: input.actorUserId,
        documentId: input.identity.documentId,
        eventId: input.requestId,
        kind: "permission-changed",
        notebookId: input.identity.notebookId,
        organizationId: input.identity.organizationId,
        recipientUserIds: recipients,
        spaceId: input.identity.spaceId,
        threadId: null,
      });
      await this.audit.appendPermissionChange(transaction, {
        actorUserId: input.actorUserId,
        occurredAt: new Date(),
        organizationId: input.identity.organizationId,
        requestId: input.requestId,
        spaceId: input.identity.spaceId,
        targetId: input.identity.documentId,
        targetType: "document",
      });
      // 只关闭变更后失权的用户连接，保留管理员和仍获授权成员的当前文档会话。
      for (const userId of deniedUserIds) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId: input.requestId,
          selectors: [
            {
              documentId: input.identity.documentId,
              kind: "document",
              notebookId: input.identity.notebookId,
              organizationId: input.identity.organizationId,
              spaceId: input.identity.spaceId,
            },
            { kind: "user", value: userId },
          ],
        });
      }
      const result = await transaction.documentAccessPolicy.findUniqueOrThrow({
        where: { id: policy.id },
        include: { grants: { orderBy: { createdAt: "asc" } } },
      });
      return this.#projectPolicy(result);
    });
  }

  /** 计算正文、评论和历史统一消费的最小能力，组成员资格在每次请求中实时读取。 */
  async decide(input: DocumentAccessInput): Promise<DocumentAccessDecision> {
    return this.database.client.$transaction((transaction) =>
      this.#decideInTransaction(transaction, input),
    );
  }

  /** 在没有调用方事务的内容入口执行一次文档能力判定，统一隐藏失权文档。 */
  async requireDocumentRole(
    input: DocumentAccessInput,
    required: DocumentAccessRole,
  ): Promise<DocumentAccessDecision> {
    return this.database.client.$transaction((transaction) =>
      this.requireRole(transaction, input, required),
    );
  }

  /** 在调用方已有事务时复用同一权限 owner，避免 controller/service 重复解释 ACL。 */
  decideInTransaction(
    transaction: Prisma.TransactionClient,
    input: DocumentAccessInput,
  ): Promise<DocumentAccessDecision> {
    return this.#decideInTransaction(transaction, input);
  }

  /** 在目录分页事务内过滤无权文档，避免受限文档继续出现在浏览器导航中。 */
  async filterVisibleDocumentsInTransaction(
    transaction: Prisma.TransactionClient,
    input: {
      actorUserId: string;
      documents: readonly Pick<DocumentIdentity, "documentId" | "notebookId">[];
      organizationId: string;
      spaceId: string;
    },
  ): Promise<readonly Pick<DocumentIdentity, "documentId" | "notebookId">[]> {
    if (input.documents.length === 0) {
      return [];
    }
    const membership = await transaction.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: input.organizationId,
          userId: input.actorUserId,
        },
      },
      select: { role: true, status: true, user: { select: { status: true } } },
    });
    if (
      membership === null ||
      membership.status !== "active" ||
      membership.user.status !== "active"
    ) {
      return [];
    }
    const [space, spaceMembership, groupGrants] = await Promise.all([
      transaction.space.findFirst({
        where: {
          id: input.spaceId,
          organizationId: input.organizationId,
          organization: { status: "active" },
          status: "active",
        },
        select: { id: true },
      }),
      transaction.spaceMembership.findFirst({
        where: {
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          status: "active",
          userId: input.actorUserId,
        },
        select: { role: true },
      }),
      transaction.spaceGroupGrant.findMany({
        where: {
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          group: {
            status: "active",
            memberships: {
              some: {
                organizationId: input.organizationId,
                userId: input.actorUserId,
                organizationMembership: { status: "active" },
              },
            },
          },
        },
        select: { role: true },
      }),
    ]);
    if (space === null) {
      return [];
    }
    const organizationManager =
      membership.role === "owner" || membership.role === "admin";
    const spaceRole = [
      spaceMembership?.role,
      ...groupGrants.map((grant) => grant.role),
    ].reduce<"admin" | "editor" | "viewer" | null>(
      (current, role) =>
        role === undefined
          ? current
          : current === null ||
              ({ viewer: 1, editor: 2, admin: 3 }[role] >
                { viewer: 1, editor: 2, admin: 3 }[current])
            ? role
            : current,
      null,
    );
    const inheritedRole =
      organizationManager || spaceRole === "admin"
        ? "editor"
        : spaceRole === "editor"
          ? "editor"
          : spaceRole === "viewer"
            ? "viewer"
            : null;
    if (organizationManager || spaceRole === "admin") {
      return input.documents;
    }
    const policies = await transaction.documentAccessPolicy.findMany({
      where: {
        organizationId: input.organizationId,
        spaceId: input.spaceId,
        OR: input.documents.map((document) => ({
          documentId: document.documentId,
          notebookId: document.notebookId,
        })),
      },
      select: {
        documentId: true,
        grants: {
          where: {
            OR: [
              { kind: "user", userId: input.actorUserId },
              {
                kind: "group",
                group: {
                  status: "active",
                  memberships: {
                    some: {
                      organizationId: input.organizationId,
                      userId: input.actorUserId,
                      organizationMembership: { status: "active" },
                    },
                  },
                },
              },
            ],
          },
          select: { role: true },
        },
        mode: true,
        notebookId: true,
      },
    });
    const policyByDocument = new Map(
      policies.map((policy) => [
        `${policy.notebookId}:${policy.documentId}`,
        policy,
      ]),
    );
    // 目录分页是热路径，先批量读取当前页策略与 grant，再在内存中派生可见项，避免逐文档事务查询。
    return input.documents.filter((document) => {
      const policy = policyByDocument.get(
        `${document.notebookId}:${document.documentId}`,
      );
      if (policy === undefined || policy.mode === "inherit") {
        return inheritedRole !== null;
      }
      return policy.grants.reduce<DocumentAccessRole | null>(
        (role, grant) => strongerRole(role, grant.role),
        null,
      ) !== null;
    });
  }

  /** 在已有控制面事务内执行唯一文档能力判定，失权统一隐藏为 404，避免不同入口泄露 ACL 状态。 */
  async requireRole(
    transaction: Prisma.TransactionClient,
    input: DocumentAccessInput,
    required: DocumentAccessRole,
  ): Promise<DocumentAccessDecision> {
    const decision = await this.#decideInTransaction(transaction, input);
    if (decision.role === null) {
      throw notFound();
    }
    if (documentRoleWeight[decision.role] < documentRoleWeight[required]) {
      throw forbidden();
    }
    return decision;
  }

  /** 在单一事务内合并组织、空间、组和文档 grant，返回正文与协作共用的能力结果。 */
  async #decideInTransaction(
    transaction: Prisma.TransactionClient,
    input: DocumentAccessInput,
  ): Promise<DocumentAccessDecision> {
    const membership = await transaction.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: input.organizationId,
          userId: input.actorUserId,
        },
      },
      select: { role: true, status: true, user: { select: { status: true } } },
    });
    if (
      membership === null ||
      membership.status !== "active" ||
      membership.user.status !== "active"
    ) {
      return { canManage: false, role: null };
    }
    const organizationManager = membership.role === "owner" || membership.role === "admin";
    const [space, spaceMembership, groupGrants, policy] = await Promise.all([
      transaction.space.findFirst({
        where: {
          id: input.spaceId,
          organizationId: input.organizationId,
          organization: { status: "active" },
          status: "active",
        },
        select: { id: true },
      }),
      transaction.spaceMembership.findFirst({
        where: {
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          status: "active",
          userId: input.actorUserId,
        },
        select: { role: true },
      }),
      transaction.spaceGroupGrant.findMany({
        where: {
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          group: {
            status: "active",
            memberships: {
              some: {
                organizationId: input.organizationId,
                userId: input.actorUserId,
                organizationMembership: { status: "active" },
              },
            },
          },
        },
        select: { role: true },
      }),
      transaction.documentAccessPolicy.findUnique({
        where: {
          organizationId_spaceId_notebookId_documentId: {
            documentId: input.documentId,
            notebookId: input.notebookId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
          },
        },
        select: { id: true, mode: true },
      }),
    ]);
    if (space === null) {
      return { canManage: false, role: null };
    }
    const spaceRole = [
      spaceMembership?.role,
      ...groupGrants.map((grant) => grant.role),
    ].reduce<"admin" | "editor" | "viewer" | null>(
      (current, role) =>
        role === undefined
          ? current
          : current === null ||
              ({ viewer: 1, editor: 2, admin: 3 }[role] >
                { viewer: 1, editor: 2, admin: 3 }[current])
            ? role
            : current,
      null,
    );
    const canManage = organizationManager || spaceRole === "admin";
    if (organizationManager || spaceRole === "admin") {
      return { canManage: true, role: "editor" };
    }
    if (policy === null || policy.mode === "inherit") {
      return {
        canManage: false,
        role:
          spaceRole === "editor"
            ? "editor"
            : spaceRole === "viewer"
              ? "viewer"
              : null,
      };
    }
    const grants = await transaction.documentAccessGrant.findMany({
      where: {
        policyId: policy.id,
        OR: [
          { kind: "user", userId: input.actorUserId },
          {
            kind: "group",
            group: {
              status: "active",
              memberships: {
                some: {
                  organizationId: input.organizationId,
                  userId: input.actorUserId,
                  organizationMembership: { status: "active" },
                },
              },
            },
          },
        ],
      },
      select: { role: true },
    });
    const role = grants.reduce<DocumentAccessRole | null>(
      (current, grant) => strongerRole(current, grant.role),
      null,
    );
    return { canManage, role };
  }

  #projectPolicy(
    policy: Prisma.DocumentAccessPolicyGetPayload<{ include: { grants: true } }>,
  ): DocumentAccessPolicy {
    return {
      documentId: policy.documentId,
      grants: policy.grants.map(
        (grant): DocumentAccessGrant => ({
          createdAt: grant.createdAt.toISOString(),
          grantId: grant.id,
          groupId: grant.groupId,
          kind: grant.kind,
          role: grant.role,
          userId: grant.userId,
        }),
      ),
      mode: policy.mode,
      notebookId: policy.notebookId,
      organizationId: policy.organizationId,
      spaceId: policy.spaceId,
    };
  }
}
