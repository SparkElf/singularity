import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { SCIM_CORE_GROUP_SCHEMA, SCIM_CORE_USER_SCHEMA, SCIM_LIST_RESPONSE_SCHEMA } from "@singularity/contracts";
import type {
  DocumentGovernance,
  GovernanceClassification,
  GovernanceDashboard,
  GovernanceEmbeddedObjectRequest,
  GovernanceClassificationRequest,
  GovernanceLegalHoldRequest,
  GovernancePolicy,
  GovernancePolicyResponse,
  GovernanceSearchRequest,
  GovernanceTransitionRequest,
  GovernanceTemplateRequest,
  GovernanceTemplateDocumentRequest,
  GovernanceTemplateDocumentResponse,
  ScimSyncRequest,
  ScimGroupRequest,
  ScimGroupResource,
  ScimListQuery,
  ScimPatchRequest,
  ScimUserRequest,
  ScimUserResource,
  MfaFactorRequest,
  MfaVerifyRequest,
  AiChatRequest,
  AiChatResponse,
} from "@singularity/contracts";
import { $Enums, AuditWriter, DatabaseRuntime, Prisma, type DatabaseClient } from "@singularity/database";

import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { ContentDirectoryService } from "../kernel/content-directory.service.js";
import { SpaceDiscoveryService } from "../kernel/space-discovery.service.js";
import { OrganizationManagementService } from "../organizations/organization-management.service.js";
import { SpaceManagementService } from "../spaces/space-management.service.js";
import { SpaceAccessService } from "../spaces/space-access.service.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { conflict, forbidden, notFound, scimError, unauthenticated } from "../problem.js";
import { MfaService } from "../identity/mfa.service.js";
import { AI_PROVIDER } from "../tokens.js";
import type { AiProvider } from "./ai-provider.js";

interface DocumentScope {
  readonly organizationId: string;
  readonly spaceId: string;
  readonly notebookId: string;
  readonly documentId: string;
}

type ScimReadClient = DatabaseClient | Prisma.TransactionClient;

const classificationWeight: Record<GovernanceClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const lifecycleToContract: Record<string, DocumentGovernance["lifecycle"]> = {
  draft: "draft",
  in_review: "in-review",
  approved: "approved",
  published: "published",
  archived: "archived",
  rejected: "rejected",
};

const verificationToContract: Record<string, DocumentGovernance["verification"]> = {
  verified: "verified",
  needs_review: "needs-review",
  expired: "expired",
};

function digestSecret(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function newContentId(now: Date): string {
  const timestamp = [
    now.getUTCFullYear().toString().padStart(4, "0"),
    (now.getUTCMonth() + 1).toString().padStart(2, "0"),
    now.getUTCDate().toString().padStart(2, "0"),
    now.getUTCHours().toString().padStart(2, "0"),
    now.getUTCMinutes().toString().padStart(2, "0"),
    now.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  const suffix = BigInt(`0x${randomBytes(5).toString("hex")}`).toString(36).padStart(7, "0").slice(-7);
  return `${timestamp}-${suffix}`;
}

type ScimUserState = {
  readonly externalId: string;
  readonly lastSyncedAt: Date;
  readonly user: { readonly id: string; readonly loginIdentifier: string; readonly status: $Enums.UserStatus };
  readonly membership: { readonly status: $Enums.MembershipStatus };
};

type ScimGroupState = {
  readonly externalId: string;
  readonly lastSyncedAt: Date;
  readonly group: { readonly id: string; readonly name: string; readonly status: $Enums.UserGroupStatus };
};

/** 把组织成员状态投影为 SCIM User 资源；active 同时受全局账号和当前组织成员状态约束。 */
function scimUserResource(state: ScimUserState): ScimUserResource {
  return {
    active: state.user.status === "active" && state.membership.status === "active",
    externalId: state.externalId,
    id: state.externalId,
    meta: { lastModified: state.lastSyncedAt.toISOString(), resourceType: "User" },
    schemas: [SCIM_CORE_USER_SCHEMA],
    userName: state.user.loginIdentifier,
  };
}

/** 把活动组和已解析成员投影为 SCIM Group 资源，成员 ID 只使用外部身份映射。 */
function scimGroupResource(
  state: ScimGroupState,
  members: ScimGroupResource["members"],
): ScimGroupResource {
  return {
    displayName: state.group.name,
    externalId: state.externalId,
    id: state.externalId,
    members,
    meta: { lastModified: state.lastSyncedAt.toISOString(), resourceType: "Group" },
    schemas: [SCIM_CORE_GROUP_SCHEMA],
  };
}

@Injectable()
export class EnterpriseGovernanceService {
  readonly #logger = new Logger("EnterpriseGovernanceService");

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly access: DocumentAccessPolicyService,
    private readonly organizations: OrganizationManagementService,
    private readonly spaces: SpaceManagementService,
    private readonly spaceAccess: SpaceAccessService,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly directory: ContentDirectoryService,
    private readonly discovery: SpaceDiscoveryService,
    private readonly audit: AuditWriter,
    private readonly mfa: MfaService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AiProvider,
  ) {}

  /** 读取空间治理策略；策略读取统一由空间管理员权限拥有，避免客户端自证管理能力。 */
  async getPolicy(actorUserId: string, organizationId: string, spaceId: string): Promise<GovernancePolicyResponse> {
    const policy = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(transaction, actorUserId, organizationId, spaceId);
      return transaction.governancePolicy.upsert({
        where: { organizationId_spaceId: { organizationId, spaceId } },
        create: {
          organizationId,
          spaceId,
          createdByUserId: actorUserId,
          verificationIntervalDays: 180,
          verificationGraceDays: 30,
          archiveAfterDays: 365,
          retentionDays: 2555,
          defaultClassification: "internal",
          watermarkEnabled: true,
          governanceEnabled: false,
        },
        update: {},
      });
    });
    return this.#projectPolicy(policy);
  }

  /** 在单一事务内更新治理策略，并把策略变更写入既有不可变审计链。 */
  async updatePolicy(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    value: GovernancePolicy,
    requestId: string,
  ): Promise<GovernancePolicyResponse> {
    const policy = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(transaction, actorUserId, organizationId, spaceId);
      const result = await transaction.governancePolicy.upsert({
        where: { organizationId_spaceId: { organizationId, spaceId } },
        create: { ...value, organizationId, spaceId, createdByUserId: actorUserId },
        update: value,
      });
      await this.audit.append(transaction, {
        action: "content.edit",
        actorUserId,
        occurredAt: new Date(),
        organizationId,
        outcome: "succeeded",
        requestId,
        spaceId,
        targetId: result.id,
        targetType: "space",
      });
      return result;
    });
    return this.#projectPolicy(policy);
  }

  /** 读取文档治理事实；文档可见性先经过统一 ACL owner，再原子初始化缺省控制面记录。 */
  async getDocument(actorUserId: string, scope: DocumentScope): Promise<DocumentGovernance> {
    const document = await this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "viewer");
      // 首次打开文档时建立 draft/needs_review 控制面事实，避免用户入口因治理表尚无记录而得到 404。
      const createData = await this.#documentGovernanceData(transaction, actorUserId, scope, new Date());
      return transaction.documentGovernance.upsert({
        where: { organizationId_spaceId_notebookId_documentId: scope },
        create: createData,
        update: {},
      });
    });
    return this.#projectDocument(document);
  }

  /** 执行受治理状态机约束的唯一状态转换；正文版本只作为当前审批的显式合同字段。 */
  async transition(
    actorUserId: string,
    scope: DocumentScope,
    input: GovernanceTransitionRequest,
    requestId: string,
  ): Promise<DocumentGovernance> {
    const now = new Date();
    return this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "editor");
      await this.#requireGovernanceEnabled(transaction, scope.organizationId, scope.spaceId);
      let existing = await transaction.documentGovernance.findUnique({
        where: { organizationId_spaceId_notebookId_documentId: scope },
      });
      if (existing !== null) {
        // 锁住治理行后再读取状态，保证并发审批不会同时消费同一个 pending 决定。
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "document_governance"
          WHERE "organization_id" = ${scope.organizationId}::uuid
            AND "space_id" = ${scope.spaceId}::uuid
            AND "notebook_id" = ${scope.notebookId}
            AND "document_id" = ${scope.documentId}
          FOR UPDATE
        `);
        existing = await transaction.documentGovernance.findUnique({
          where: { organizationId_spaceId_notebookId_documentId: scope },
        });
      }
      const current = existing ?? await this.createDocumentGovernance(transaction, actorUserId, scope, now);
      const next = this.#nextLifecycle(current.lifecycle, input.action);
      const versionToken = input.versionToken ?? current.currentVersion ?? undefined;
      if ((input.action === "submit" || input.action === "approve") && versionToken === undefined) {
        throw conflict();
      }
      if (input.action === "submit" && versionToken !== undefined) {
        const approval = await transaction.governanceApprovalRequest.findUnique({
          where: { organizationId_spaceId_notebookId_documentId_versionToken: { ...scope, versionToken } },
          select: { status: true },
        });
        if (approval !== null && approval.status !== "pending") {
          throw conflict();
        }
        if (approval === null) {
          await transaction.governanceApprovalRequest.create({
            data: { ...scope, versionToken, status: "pending", submittedByUserId: actorUserId },
          });
        }
      }
      if ((input.action === "approve" || input.action === "reject") && versionToken !== undefined) {
        if (current.currentVersion !== versionToken) {
          throw conflict();
        }
        const approval = await transaction.governanceApprovalRequest.findUnique({
          where: { organizationId_spaceId_notebookId_documentId_versionToken: { ...scope, versionToken } },
        });
        if (approval === null || approval.status !== "pending") {
          throw conflict();
        }
        const decided = await transaction.governanceApprovalRequest.updateMany({
          where: { id: approval.id, status: "pending" },
          data: { status: input.action === "approve" ? "approved" : "rejected", decidedByUserId: actorUserId, decisionComment: input.comment ?? null, decidedAt: now },
        });
        if (decided.count !== 1) {
          throw conflict();
        }
      }
      if (input.action === "archive" && current.legalHold) {
        throw conflict();
      }
      const policy = input.action === "verify"
        ? await transaction.governancePolicy.findUnique({ where: { organizationId_spaceId: { organizationId: scope.organizationId, spaceId: scope.spaceId } }, select: { verificationIntervalDays: true } })
        : null;
      const updated = await transaction.documentGovernance.update({
        where: { id: current.id },
        data: {
          lifecycle: next as $Enums.GovernanceLifecycleStatus,
          ...(versionToken === undefined ? {} : { currentVersion: versionToken }),
          ...(input.action === "verify" ? { verification: "verified", nextVerificationAt: new Date(now.getTime() + (policy?.verificationIntervalDays ?? 180) * 86_400_000) } : {}),
          ...(input.action === "archive" ? { archivedAt: now } : {}),
          ...(input.action === "restore" ? { archivedAt: null, verification: "needs_review" } : {}),
        },
      });
      if (input.action === "verify" || input.action === "archive") {
        await this.#queueTask(transaction, scope, input.action, versionToken ?? "current");
      }
      await this.audit.append(transaction, {
        action: input.action === "archive" ? "content.delete" : "content.edit",
        actorUserId,
        occurredAt: now,
        organizationId: scope.organizationId,
        outcome: "succeeded",
        requestId,
        spaceId: scope.spaceId,
        targetId: scope.documentId,
        targetType: "document",
      });
      return this.#projectDocument(updated);
    });
  }

  /** 列出当前文档的审批记录；版本和四段身份一起返回，防止迟到决定覆盖新版本。 */
  async listApprovals(actorUserId: string, scope: DocumentScope) {
    const approvals = await this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "viewer");
      return transaction.governanceApprovalRequest.findMany({
        where: scope,
        orderBy: { submittedAt: "desc" },
      });
    });
    return {
      approvals: approvals.map((approval) => ({
        requestId: approval.id,
        status: approval.status,
        submittedAt: approval.submittedAt.toISOString(),
        ...(approval.decidedAt === null ? {} : { decidedAt: approval.decidedAt.toISOString() }),
        ...(approval.decisionComment === null ? {} : { decisionComment: approval.decisionComment }),
        versionToken: approval.versionToken,
      })),
    };
  }

  /** 管理模板目录；模板只保存创建初始内容所需的元数据，不成为正文第二事实源。 */
  async createTemplate(actorUserId: string, organizationId: string, spaceId: string, input: GovernanceTemplateRequest, requestId: string) {
    return this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(transaction, actorUserId, organizationId, spaceId);
      await this.#requireGovernanceEnabled(transaction, organizationId, spaceId);
      const template = await transaction.governanceTemplate.create({
        data: {
          defaultClassification: input.defaultClassification,
          description: input.description ?? null,
          initialContent: input.initialContent,
          name: input.name,
          organizationId,
          spaceId,
          status: "draft",
          verificationIntervalDays: input.verificationIntervalDays,
          createdByUserId: actorUserId,
        },
      });
      await this.audit.append(transaction, {
        action: "content.edit",
        actorUserId,
        occurredAt: new Date(),
        organizationId,
        outcome: "succeeded",
        requestId,
        spaceId,
        targetId: template.id,
        targetType: "template",
      });
      return this.#projectTemplate(template);
    });
  }

  /** 列出当前空间仍可使用的治理模板，已归档模板不进入管理端消费链。 */
  async listTemplates(actorUserId: string, organizationId: string, spaceId: string) {
    const templates = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(transaction, actorUserId, organizationId, spaceId);
      return transaction.governanceTemplate.findMany({
        where: { organizationId, spaceId, status: { not: "archived" } },
        orderBy: { updatedAt: "desc" },
      });
    });
    return { templates: templates.map((template) => this.#projectTemplate(template)) };
  }

  /** 发布模板只改变模板目录状态；创建文档时由上游一次性消费初始结构，不把模板变成正文事实源。 */
  async publishTemplate(actorUserId: string, organizationId: string, spaceId: string, templateId: string, requestId: string) {
    const result = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(transaction, actorUserId, organizationId, spaceId);
      await this.#requireGovernanceEnabled(transaction, organizationId, spaceId);
      const updated = await transaction.governanceTemplate.updateMany({ where: { id: templateId, organizationId, spaceId, status: "draft" }, data: { status: "published" } });
      if (updated.count === 0) {
        throw notFound();
      }
      await this.audit.appendPermissionChange(transaction, { actorUserId, occurredAt: new Date(), organizationId, requestId, spaceId, targetId: templateId, targetType: "template" });
      const template = await transaction.governanceTemplate.findUniqueOrThrow({ where: { id: templateId } });
      return this.#projectTemplate(template);
    });
    this.#logger.log({ event: "governance.template.published", organizationId, spaceId, templateId, requestId });
    return result;
  }

  /**
   * 应用已发布模板：先由 Kernel 创建正文，再在控制面写入一次治理元数据。
   * `documentId` 在 API 边界生成并贯穿 Kernel/治理/审计，任何失败都保留原始堆栈。
   */
  async createDocumentFromTemplate(
    actorUserId: string,
    organizationId: string,
    spaceId: string,
    templateId: string,
    input: GovernanceTemplateDocumentRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<GovernanceTemplateDocumentResponse> {
    const template = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(transaction, actorUserId, organizationId, spaceId);
      await this.#requireGovernanceEnabled(transaction, organizationId, spaceId);
      return transaction.governanceTemplate.findFirst({ where: { id: templateId, organizationId, spaceId, status: "published" } });
    });
    if (template === null) {
      throw notFound();
    }
    const documentId = newContentId(new Date());
    const initialContent = template.initialContent as { markdown?: string };
    await this.directory.createDocument({
      actorUserId,
      documentId,
      markdown: initialContent.markdown ?? "",
      notebookId: input.notebookId,
      ...(input.parentDocumentId === undefined ? {} : { parentDocumentId: input.parentDocumentId }),
      organizationId,
      requestId,
      signal,
      spaceId,
      title: input.title,
    });
    const now = new Date();
    await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(transaction, actorUserId, organizationId, spaceId);
      const policy = await transaction.governancePolicy.findUnique({ where: { organizationId_spaceId: { organizationId, spaceId } } });
      await transaction.documentGovernance.create({
        data: {
          classification: template.defaultClassification,
          documentId,
          lifecycle: "draft",
          nextVerificationAt: new Date(now.getTime() + template.verificationIntervalDays * 86_400_000),
          notebookId: input.notebookId,
          organizationId,
          ownerUserId: actorUserId,
          ...(policy === null ? {} : { retentionUntil: new Date(now.getTime() + policy.retentionDays * 86_400_000) }),
          spaceId,
          verification: "needs_review",
        },
      });
      await this.audit.append(transaction, {
        action: "content.edit",
        actorUserId,
        occurredAt: now,
        organizationId,
        outcome: "succeeded",
        requestId,
        spaceId,
        targetId: documentId,
        targetType: "document",
      });
    });
    return { documentId, notebookId: input.notebookId, organizationId, spaceId };
  }

  /** 密级是单调策略：允许提升或保持，不允许在下游降低上游已确认的保护级别。 */
  async setClassification(actorUserId: string, scope: DocumentScope, input: GovernanceClassificationRequest, requestId: string): Promise<DocumentGovernance> {
    return this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "editor");
      await this.#requireGovernanceEnabled(transaction, scope.organizationId, scope.spaceId);
      const current = await transaction.documentGovernance.findUnique({ where: { organizationId_spaceId_notebookId_documentId: scope } });
      const document = current ?? await this.createDocumentGovernance(transaction, actorUserId, scope, new Date());
      if (classificationWeight[input.classification] < classificationWeight[document.classification]) {
        throw conflict();
      }
      const updated = await transaction.documentGovernance.update({ where: { id: document.id }, data: { classification: input.classification } });
      await this.audit.append(transaction, { action: "content.edit", actorUserId, occurredAt: new Date(), organizationId: scope.organizationId, outcome: "succeeded", requestId, spaceId: scope.spaceId, targetId: scope.documentId, targetType: "document" });
      return this.#projectDocument(updated);
    });
  }

  /** 法律保留在治理事实表中单独持久化，开启或解除都必须经过组织管理员并留下审计。 */
  async setLegalHold(actorUserId: string, scope: DocumentScope, input: GovernanceLegalHoldRequest, requestId: string): Promise<DocumentGovernance> {
    const updated = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, scope.organizationId);
      await this.#requireGovernanceEnabled(transaction, scope.organizationId, scope.spaceId);
      const current = await transaction.documentGovernance.findUnique({ where: { organizationId_spaceId_notebookId_documentId: scope } });
      const document = current ?? await this.createDocumentGovernance(transaction, actorUserId, scope, new Date());
      const result = await transaction.documentGovernance.update({ where: { id: document.id }, data: { legalHold: input.enabled } });
      await this.audit.append(transaction, { action: "permission.change", actorUserId, occurredAt: new Date(), organizationId: scope.organizationId, outcome: "succeeded", requestId, spaceId: scope.spaceId, targetId: scope.documentId, targetType: "document" });
      return result;
    });
    return this.#projectDocument(updated);
  }

  /** 返回治理队列计数，所有计数均来自控制面事实表，不通过前端拼接或正文扫描推断。 */
  async dashboard(actorUserId: string, organizationId: string): Promise<GovernanceDashboard> {
    const [pending, needsReview, expired, holds, failed] = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId);
      return Promise.all([
        transaction.governanceApprovalRequest.count({ where: { organizationId, status: "pending" } }),
        transaction.documentGovernance.count({ where: { organizationId, verification: "needs_review" } }),
        transaction.documentGovernance.count({ where: { organizationId, verification: "expired" } }),
        transaction.documentGovernance.count({ where: { organizationId, legalHold: true } }),
        transaction.governanceTask.count({ where: { organizationId, status: "failed" } }),
      ]);
    });
    return { approvalsPending: pending, documentsExpired: expired, documentsNeedingReview: needsReview, legalHolds: holds, tasksFailed: failed };
  }

  /** 从每个已授权空间的 Kernel discovery 读取结果，再用文档 ACL 过滤，避免依赖没有生产写入链路的控制面索引。 */
  async search(
    actorUserId: string,
    organizationId: string,
    input: GovernanceSearchRequest,
    context: { readonly requestId: string; readonly signal: AbortSignal },
  ) {
    const requestedSpaceIds = [...new Set(input.spaceIds)];
    if (requestedSpaceIds.length === 0) {
      return { results: [] };
    }
    const authorizedSpaces = (await this.spaceAccess.listAuthorizedSpaces(actorUserId))
      .filter((space) => space.organizationId === organizationId && requestedSpaceIds.includes(space.spaceId));
    const discovered = await Promise.all(authorizedSpaces.map(async (space) => ({
      response: await this.discovery.search({
        actorUserId,
        body: { method: "keyword", query: input.query },
        organizationId,
        requestId: context.requestId,
        signal: context.signal,
        spaceId: space.spaceId,
      }),
      spaceId: space.spaceId,
    })));
    const candidates = discovered.flatMap(({ response, spaceId }) => response.blocks.map((block) => ({
      block,
      spaceId,
    })));
    if (candidates.length === 0) {
      return { results: [] };
    }
    const visibleKeys = await this.database.client.$transaction(async (transaction) => {
      const keys = new Set<string>();
      for (const space of authorizedSpaces) {
        const documents = candidates.filter((candidate) => candidate.spaceId === space.spaceId).map(({ block }) => ({ documentId: block.documentId, notebookId: block.notebookId }));
        const visible = await this.access.filterVisibleDocumentsInTransaction(transaction, { actorUserId, documents, organizationId, spaceId: space.spaceId });
        for (const document of visible) keys.add(`${space.spaceId}:${document.notebookId}:${document.documentId}`);
      }
      return keys;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const scopeRows = await this.database.client.$transaction(async (transaction) => {
      const rows = await transaction.documentGovernance.findMany({ where: { organizationId, OR: candidates.map(({ block, spaceId }) => ({ documentId: block.documentId, notebookId: block.notebookId, spaceId })) } });
      const policies = await transaction.governancePolicy.findMany({ where: { organizationId, spaceId: { in: authorizedSpaces.map((space) => space.spaceId) } }, select: { defaultClassification: true, spaceId: true } });
      return { policies, rows };
    });
    const governanceByKey = new Map(scopeRows.rows.map((row) => [`${row.spaceId}:${row.notebookId}:${row.documentId}`, row.classification]));
    const policyBySpace = new Map(scopeRows.policies.map((policy) => [policy.spaceId, policy.defaultClassification]));
    const seenDocuments = new Set<string>();
    const results = candidates.flatMap(({ block, spaceId }) => {
      const key = `${spaceId}:${block.notebookId}:${block.documentId}`;
      if (!visibleKeys.has(key) || seenDocuments.has(key)) return [];
      seenDocuments.add(key);
      return [{ classification: governanceByKey.get(key) ?? policyBySpace.get(spaceId) ?? "internal", document: { organizationId, spaceId, notebookId: block.notebookId, documentId: block.documentId }, excerpt: block.content, title: block.title }];
    });
    return { results };
  }

  /** 为成员幂等创建个人空间；空间仍走现有 Kernel/Space 模型，PersonalSpace 只保存归属索引。 */
  async getOrCreatePersonalSpace(actorUserId: string, organizationId: string) {
    return this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireMemberInTransaction(transaction, actorUserId, organizationId);
      const raced = await transaction.personalSpace.findUnique({ where: { organizationId_userId: { organizationId, userId: actorUserId } } });
      if (raced !== null) {
        return { organizationId, spaceId: raced.spaceId, userId: actorUserId };
      }
      const createdSpace = await this.spaceAccess.createSpaceInTransaction(transaction, { adminUserId: actorUserId, name: "个人空间", organizationId });
      if (createdSpace === "not-found") {
        throw notFound();
      }
      if (createdSpace === "conflict") {
        throw conflict();
      }
      const personal = await transaction.personalSpace.create({ data: { organizationId, userId: actorUserId, spaceId: createdSpace.spaceId } });
      return { organizationId, spaceId: personal.spaceId, userId: actorUserId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** 生成只显示一次的机器凭据；数据库仅保存不可逆摘要，完整密钥不进入日志或审计正文。 */
  async createApiKey(actorUserId: string, organizationId: string, name: string, scopes: readonly string[], expiresAt: string | undefined, requestId: string) {
    const secret = `sk_sing_${randomBytes(32).toString("base64url")}`;
    const keyPrefix = secret.slice(0, 16);
    const expires = toDate(expiresAt);
    const key = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId);
      const created = await transaction.enterpriseApiKey.create({ data: { organizationId, userId: actorUserId, name, keyPrefix, secretDigest: digestSecret("singularity.api-key.v1", secret), scopes: [...scopes], ...(expires === undefined ? {} : { expiresAt: expires }) } });
      await this.audit.appendPermissionChange(transaction, { actorUserId, occurredAt: new Date(), organizationId, requestId, spaceId: null, targetId: created.id, targetType: "api-key" });
      return created;
    });
    return { apiKeyId: key.id, keyPrefix: key.keyPrefix, name: key.name, scopes: scopes.slice(), secret, ...(key.expiresAt === null ? {} : { expiresAt: key.expiresAt.toISOString() }) };
  }

  /** 撤销机器凭据并保持幂等失败语义；撤销只影响指定组织的 key。 */
  async revokeApiKey(actorUserId: string, organizationId: string, apiKeyId: string, requestId: string): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId);
      const result = await transaction.enterpriseApiKey.updateMany({ where: { id: apiKeyId, organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (result.count === 0) {
        throw notFound();
      }
      await this.audit.appendPermissionChange(transaction, { actorUserId, occurredAt: new Date(), organizationId, requestId, spaceId: null, targetId: apiKeyId, targetType: "api-key" });
    });
    this.#logger.log({ event: "identity.api-key.revoked", apiKeyId, organizationId, requestId });
  }

  /** 列出组织机器凭据的非敏感摘要；密钥明文只在创建响应中出现一次。 */
  async listApiKeys(actorUserId: string, organizationId: string) {
    const keys = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId);
      return transaction.enterpriseApiKey.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    });
    return {
      keys: keys.map((key) => ({
        apiKeyId: key.id,
        createdAt: key.createdAt.toISOString(),
        ...(key.expiresAt === null ? {} : { expiresAt: key.expiresAt.toISOString() }),
        keyPrefix: key.keyPrefix,
        ...(key.lastUsedAt === null ? {} : { lastUsedAt: key.lastUsedAt.toISOString() }),
        name: key.name,
        ...(key.revokedAt === null ? {} : { revokedAt: key.revokedAt.toISOString() }),
        scopes: Array.isArray(key.scopes) ? key.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      })),
    };
  }

  /** 机器请求在进入业务 handler 前验证摘要、过期时间和最小 scope，调用方不得把 API Key 当用户会话。 */
  async authenticateApiKey(secret: string, requiredScope: string): Promise<{ organizationId: string; userId: string; scopes: readonly string[] }> {
    const key = await this.database.client.enterpriseApiKey.findUnique({ where: { secretDigest: digestSecret("singularity.api-key.v1", secret) } });
    if (key === null || key.revokedAt !== null || (key.expiresAt !== null && key.expiresAt <= new Date())) {
      throw unauthenticated();
    }
    const scopes = Array.isArray(key.scopes) && key.scopes.every((scope): scope is string => typeof scope === "string") ? key.scopes : [];
    if (!scopes.includes(requiredScope)) {
      throw forbidden();
    }
    const touched = await this.database.client.enterpriseApiKey.updateMany({ where: { id: key.id, revokedAt: null, ...(key.expiresAt === null ? {} : { expiresAt: { gt: new Date() } }) }, data: { lastUsedAt: new Date() } });
    if (touched.count !== 1) {
      throw unauthenticated();
    }
    return { organizationId: key.organizationId, userId: key.userId, scopes };
  }

  /** 保存企业 SAML 配置；这里只负责声明式配置和密钥边界，断言验证由专用身份适配器消费。 */
  async createSamlProvider(actorUserId: string, organizationId: string, input: { name: string; entityId: string; ssoUrl: string; certificatePem: string }, requestId: string) {
    const provider = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId, true);
      const created = await transaction.samlProvider.create({ data: { ...input, organizationId, status: "disabled", createdByUserId: actorUserId } });
      await this.audit.appendPermissionChange(transaction, { actorUserId, occurredAt: new Date(), organizationId, requestId, spaceId: null, targetId: created.id, targetType: "saml-provider" });
      return created;
    });
    this.#logger.log({ event: "identity.saml.configured", organizationId, providerId: provider.id, requestId });
    return { providerId: provider.id, name: provider.name, status: provider.status };
  }

  /** 切换 SAML provider 的启用状态；只有明确启用的配置才能接收登录断言。 */
  async setSamlProviderStatus(actorUserId: string, organizationId: string, providerId: string, status: "active" | "disabled", requestId: string) {
    await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId, true);
      const provider = await transaction.samlProvider.updateMany({ where: { id: providerId, organizationId }, data: { status } });
      if (provider.count !== 1) {
        throw notFound();
      }
      await this.audit.appendPermissionChange(transaction, { actorUserId, occurredAt: new Date(), organizationId, requestId, spaceId: null, targetId: providerId, targetType: "saml-provider" });
    });
    this.#logger.log({ event: "identity.saml.status", organizationId, providerId, requestId, status });
    return { providerId, status };
  }

  /** 返回组织 SAML provider 的公开配置摘要；证书正文只保留在服务端验证边界。 */
  async listSamlProviders(actorUserId: string, organizationId: string) {
    const providers = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId, true);
      return transaction.samlProvider.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    });
    return {
      providers: providers.map((provider) => ({
        certificateConfigured: provider.certificatePem.length > 0,
        entityId: provider.entityId,
        name: provider.name,
        providerId: provider.id,
        ssoUrl: provider.ssoUrl,
        status: provider.status,
      })),
    };
  }

  /** 创建 SCIM 机器令牌；同步端点只接受摘要匹配的令牌，不把 SCIM 当作文档 ACL 写入口。 */
  async createScimToken(actorUserId: string, organizationId: string, expiresAt: string | undefined, requestId: string) {
    const secret = `scim_sing_${randomBytes(32).toString("base64url")}`;
    const token = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId, true);
      const created = await transaction.scimToken.create({ data: { organizationId, tokenPrefix: secret.slice(0, 16), tokenDigest: digestSecret("singularity.scim.v1", secret), createdByUserId: actorUserId, ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) }) } });
      await this.audit.appendPermissionChange(transaction, { actorUserId, occurredAt: new Date(), organizationId, requestId, spaceId: null, targetId: created.id, targetType: "scim-token" });
      return created;
    });
    this.#logger.log({ event: "identity.scim.token-created", organizationId, requestId, tokenId: token.id });
    return { tokenId: token.id, tokenPrefix: token.tokenPrefix, ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt.toISOString() }), secret };
  }

  /** 撤销 SCIM 机器令牌并写入审计；撤销只影响指定组织的令牌，重复撤销返回未找到。 */
  async revokeScimToken(actorUserId: string, organizationId: string, tokenId: string, requestId: string): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId, true);
      const revoked = await transaction.scimToken.updateMany({ where: { id: tokenId, organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (revoked.count !== 1) {
        throw notFound();
      }
      await this.audit.appendPermissionChange(transaction, { actorUserId, occurredAt: new Date(), organizationId, requestId, spaceId: null, targetId: tokenId, targetType: "scim-token" });
    });
    this.#logger.log({ event: "identity.scim.token-revoked", organizationId, requestId, tokenId });
  }

  /** 列出 SCIM 令牌的非敏感摘要；令牌明文只在创建响应中出现一次。 */
  async listScimTokens(actorUserId: string, organizationId: string) {
    const tokens = await this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(transaction, actorUserId, organizationId, true);
      return transaction.scimToken.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    });
    return {
      tokens: tokens.map((token) => ({
        createdAt: token.createdAt.toISOString(),
        ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt.toISOString() }),
        ...(token.lastUsedAt === null ? {} : { lastUsedAt: token.lastUsedAt.toISOString() }),
        ...(token.revokedAt === null ? {} : { revokedAt: token.revokedAt.toISOString() }),
        tokenId: token.id,
        tokenPrefix: token.tokenPrefix,
      })),
    };
  }

  /** 校验 SCIM 令牌并更新使用时间；同步请求只允许改成员/组生命周期，不触碰文档 ACL。 */
  async authenticateScimToken(token: string): Promise<{ organizationId: string }> {
    const record = await this.database.client.scimToken.findUnique({ where: { tokenDigest: digestSecret("singularity.scim.v1", token) } });
    if (record === null || record.revokedAt !== null || (record.expiresAt !== null && record.expiresAt <= new Date())) {
      throw unauthenticated();
    }
    const touched = await this.database.client.scimToken.updateMany({ where: { id: record.id, revokedAt: null, ...(record.expiresAt === null ? {} : { expiresAt: { gt: new Date() } }) }, data: { lastUsedAt: new Date() } });
    if (touched.count !== 1) {
      throw unauthenticated();
    }
    return { organizationId: record.organizationId };
  }

  /** 返回 SCIM 服务能力声明；该响应不依赖组织内容，也不泄露令牌或成员数据。 */
  getScimServiceProviderConfig() {
    return {
      authenticationSchemes: [{
        description: "Organization-scoped bearer token",
        name: "Bearer Token",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        type: "oauthbearertoken",
      }],
      bulk: { maxOperations: 0, maxPayloadSize: 0, supported: false },
      changePassword: { supported: false },
      documentationUri: "https://www.rfc-editor.org/rfc/rfc7644",
      filter: { maxResults: 200, supported: true },
      patch: { supported: true },
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig" as const],
      sort: { supported: false },
    };
  }

  /** 查询一页 SCIM 用户；资源身份只来自组织内 external identity 映射。 */
  async listScimUsers(organizationId: string, query: ScimListQuery) {
    if (query.filter?.attribute === "displayName") throw scimError(400, "Only userName filtering is supported for Users", "invalidFilter");
    const identities = await this.database.client.scimExternalIdentity.findMany({
      orderBy: [{ externalId: "asc" }, { id: "asc" }],
      select: { externalId: true, id: true, lastSyncedAt: true, userId: true },
      where: { organizationId, kind: "user", userId: { not: null } },
    });
    const userIds = identities.flatMap((identity) => identity.userId === null ? [] : [identity.userId]);
    const userWhere: Prisma.UserWhereInput = { id: { in: userIds } };
    if (query.filter !== undefined) {
      userWhere.loginIdentifier = query.filter.attribute === "userName" ? query.filter.value : { in: [] };
    }
    const users = await this.database.client.user.findMany({
      select: {
        id: true,
        loginIdentifier: true,
        organizationMemberships: { where: { organizationId }, select: { status: true } },
        status: true,
      },
      where: userWhere,
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    const resources = identities.flatMap((identity) => {
      if (identity.userId === null) return [];
      const user = userById.get(identity.userId);
      const membership = user?.organizationMemberships[0];
      if (user === undefined || membership === undefined) return [];
      return [scimUserResource({ externalId: identity.externalId, lastSyncedAt: identity.lastSyncedAt, user, membership })];
    });
    return this.#scimListResponse(resources, query);
  }

  /** 读取单个 SCIM 用户；不存在或类型冲突均使用标准 SCIM 404。 */
  async getScimUser(organizationId: string, resourceId: string): Promise<ScimUserResource> {
    const state = await this.#loadScimUserState(this.database.client, organizationId, resourceId);
    return scimUserResource(state);
  }

  /** 创建或幂等更新 SCIM 用户，并将停用收敛到既有会话/API Key 撤权链路。 */
  async createScimUser(organizationId: string, input: ScimUserRequest, requestId: string): Promise<ScimUserResource> {
    return this.database.client.$transaction(async (transaction) => {
      await this.#upsertScimUser(transaction, organizationId, input, requestId);
      const state = await this.#loadScimUserState(transaction, organizationId, input.externalId ?? input.userName);
      await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: state.user.id, targetType: "user" });
      return scimUserResource(state);
    });
  }

  /** 按声明顺序应用 SCIM 用户 replace 操作，所有状态变化在一个事务中完成。 */
  async patchScimUser(organizationId: string, resourceId: string, input: ScimPatchRequest, requestId: string): Promise<ScimUserResource> {
    return this.database.client.$transaction(async (transaction) => {
      let currentId = resourceId;
      for (const operation of input.Operations) {
        if (operation.op !== "replace" || operation.path === undefined || !["active", "userName", "externalId"].includes(operation.path)) {
          throw scimError(400, "The SCIM user PATCH path or operation is not supported", "invalidPath");
        }
        const state = await this.#loadScimUserState(transaction, organizationId, currentId);
        if (operation.path === "active") {
          if (typeof operation.value !== "boolean") throw scimError(400, "The active value must be boolean", "invalidValue");
          await this.#setScimUserActive(transaction, organizationId, state.user.id, operation.value, requestId);
        } else if (operation.path === "userName") {
          if (typeof operation.value !== "string" || operation.value.trim().length === 0) throw scimError(400, "The userName value is invalid", "invalidValue");
          const collision = await transaction.user.findUnique({ where: { loginIdentifier: operation.value.trim() }, select: { id: true } });
          if (collision !== null && collision.id !== state.user.id) throw scimError(409, "The userName is already assigned", "uniqueness");
          await transaction.user.update({ where: { id: state.user.id }, data: { loginIdentifier: operation.value.trim() } });
        } else {
          if (typeof operation.value !== "string" || operation.value.trim().length === 0) throw scimError(400, "The externalId value is invalid", "invalidValue");
          const nextId = operation.value.trim();
          const collision = await transaction.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId: nextId } } });
          if (collision !== null && collision.externalId !== currentId) throw scimError(409, "The externalId is already assigned", "uniqueness");
          await transaction.scimExternalIdentity.update({ where: { organizationId_externalId: { organizationId, externalId: currentId } }, data: { externalId: nextId, lastSyncedAt: new Date() } });
          currentId = nextId;
        }
      }
      await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: currentId, targetType: "user" });
      return scimUserResource(await this.#loadScimUserState(transaction, organizationId, currentId));
    });
  }

  /** SCIM DELETE 语义等价于 active=false，保留映射和审计历史。 */
  async deleteScimUser(organizationId: string, resourceId: string, requestId: string): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const state = await this.#loadScimUserState(transaction, organizationId, resourceId);
      await this.#setScimUserActive(transaction, organizationId, state.user.id, false, requestId);
    });
  }

  /** 查询一页 SCIM 组，并将成员投影为对应的 SCIM 用户资源 ID。 */
  async listScimGroups(organizationId: string, query: ScimListQuery) {
    if (query.filter?.attribute === "userName") throw scimError(400, "Only displayName filtering is supported for Groups", "invalidFilter");
    const identities = await this.database.client.scimExternalIdentity.findMany({
      orderBy: [{ externalId: "asc" }, { id: "asc" }],
      select: { externalId: true, groupId: true, id: true, lastSyncedAt: true },
      where: {
        organizationId,
        groupId: { not: null },
        kind: "group",
      },
    });
    const groupIds = identities.flatMap((identity) => identity.groupId === null ? [] : [identity.groupId]);
    const groupWhere: Prisma.UserGroupWhereInput = { id: { in: groupIds }, organizationId, status: "active" };
    if (query.filter !== undefined) {
      groupWhere.name = query.filter.attribute === "displayName" ? query.filter.value : { in: [] };
    }
    const groups = await this.database.client.userGroup.findMany({
      select: { id: true, name: true, status: true },
      where: groupWhere,
    });
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const resources: ScimGroupResource[] = [];
    for (const identity of identities) {
      if (identity.groupId === null) continue;
      const group = groupById.get(identity.groupId);
      if (group === undefined) continue;
      resources.push(scimGroupResource({ externalId: identity.externalId, group, lastSyncedAt: identity.lastSyncedAt }, await this.#scimGroupMembers(this.database.client, organizationId, group.id)));
    }
    return this.#scimListResponse(resources, query);
  }

  /** 读取单个 SCIM 组及当前成员关系。 */
  async getScimGroup(organizationId: string, resourceId: string): Promise<ScimGroupResource> {
    const state = await this.#loadScimGroupState(this.database.client, organizationId, resourceId);
    return scimGroupResource(state, await this.#scimGroupMembers(this.database.client, organizationId, state.group.id));
  }

  /** 创建或幂等更新 SCIM 组，并按请求提供的成员集合收敛关系。 */
  async createScimGroup(organizationId: string, input: ScimGroupRequest, requestId: string): Promise<ScimGroupResource> {
    return this.database.client.$transaction(async (transaction) => {
      const state = await this.#upsertScimGroup(transaction, organizationId, input);
      if (input.members !== undefined) await this.#replaceScimGroupMembers(transaction, organizationId, state.group.id, input.members.map((member) => member.value), requestId);
      const updated = await this.#loadScimGroupState(transaction, organizationId, state.externalId);
      await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: updated.group.id, targetType: "group" });
      return scimGroupResource(updated, await this.#scimGroupMembers(transaction, organizationId, updated.group.id));
    });
  }

  /** 应用 SCIM 组名称、资源 ID 和成员 add/remove/replace 操作。 */
  async patchScimGroup(organizationId: string, resourceId: string, input: ScimPatchRequest, requestId: string): Promise<ScimGroupResource> {
    return this.database.client.$transaction(async (transaction) => {
      let currentId = resourceId;
      for (const operation of input.Operations) {
        const path = operation.path;
        if (path === "displayName") {
          if (operation.op !== "replace" || typeof operation.value !== "string" || operation.value.trim().length === 0) throw scimError(400, "The displayName PATCH operation is invalid", "invalidValue");
          const state = await this.#loadScimGroupState(transaction, organizationId, currentId);
          const collision = await transaction.userGroup.findFirst({ where: { organizationId, name: operation.value.trim(), id: { not: state.group.id } }, select: { id: true } });
          if (collision !== null) throw scimError(409, "The displayName is already assigned", "uniqueness");
          await transaction.userGroup.update({ where: { id: state.group.id }, data: { name: operation.value.trim() } });
        } else if (path === "externalId") {
          if (operation.op !== "replace" || typeof operation.value !== "string" || operation.value.trim().length === 0) throw scimError(400, "The externalId PATCH operation is invalid", "invalidValue");
          const nextId = operation.value.trim();
          const collision = await transaction.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId: nextId } } });
          if (collision !== null && collision.externalId !== currentId) throw scimError(409, "The externalId is already assigned", "uniqueness");
          await transaction.scimExternalIdentity.update({ where: { organizationId_externalId: { organizationId, externalId: currentId } }, data: { externalId: nextId, lastSyncedAt: new Date() } });
          currentId = nextId;
        } else if (path === "members" || path?.startsWith("members[value eq ")) {
          const memberIds = this.#scimPatchMemberIds(operation, path);
          const state = await this.#loadScimGroupState(transaction, organizationId, currentId);
          if (operation.op === "replace") await this.#replaceScimGroupMembers(transaction, organizationId, state.group.id, memberIds, requestId);
          else if (operation.op === "add") await this.#addScimGroupMembers(transaction, organizationId, state.group.id, memberIds, requestId);
          else await this.#removeScimGroupMembers(transaction, organizationId, state.group.id, memberIds, requestId);
        } else {
          throw scimError(400, "The SCIM group PATCH path is not supported", "invalidPath");
        }
      }
      const state = await this.#loadScimGroupState(transaction, organizationId, currentId);
      await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: state.group.id, targetType: "group" });
      return scimGroupResource(state, await this.#scimGroupMembers(transaction, organizationId, state.group.id));
    });
  }

  /** SCIM DELETE 禁用组并清理其成员关系，不删除文档 ACL 事实。 */
  async deleteScimGroup(organizationId: string, resourceId: string, requestId: string): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const state = await this.#loadScimGroupState(transaction, organizationId, resourceId);
      const members = await transaction.userGroupMembership.findMany({ where: { organizationId, groupId: state.group.id }, select: { userId: true } });
      await transaction.userGroup.update({ where: { id: state.group.id }, data: { status: "disabled" } });
      await transaction.userGroupMembership.deleteMany({ where: { organizationId, groupId: state.group.id } });
      await this.#publishScimGroupAccessChanges(transaction, organizationId, state.group.id, members.map((member) => member.userId), requestId);
      await transaction.scimExternalIdentity.update({ where: { organizationId_externalId: { organizationId, externalId: resourceId } }, data: { lastSyncedAt: new Date() } });
      await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: state.group.id, targetType: "group" });
    });
  }

  /** 内部批量入口复用标准 SCIM 用户/组 use case，避免形成第二套状态机。 */
  async syncScim(organizationId: string, input: ScimSyncRequest, requestId: string): Promise<{ groups: number; users: number }> {
    return this.database.client.$transaction(async (transaction) => {
      for (const user of input.users) {
        await this.#upsertScimUser(transaction, organizationId, { active: user.active, externalId: user.externalId, userName: user.loginIdentifier }, requestId);
      }
      for (const group of input.groups) {
        await this.#upsertScimGroup(transaction, organizationId, { displayName: group.name, externalId: group.externalId });
      }
      await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: organizationId, targetType: "organization" });
      return { groups: input.groups.length, users: input.users.length };
    });
  }


  /** 按协议的 1-based startIndex/count 截取已排序资源，并返回稳定分页元数据。 */
  #scimListResponse<T extends ScimUserResource | ScimGroupResource>(resources: readonly T[], query: ScimListQuery) {
    const start = query.startIndex - 1;
    const page = resources.slice(start, start + query.count);
    return {
      Resources: page,
      itemsPerPage: page.length,
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      startIndex: query.startIndex,
      totalResults: resources.length,
    };
  }

  /** 读取 SCIM 用户的组织映射、账号状态和成员状态，确保资源身份不跨组织。 */
  async #loadScimUserState(client: ScimReadClient, organizationId: string, resourceId: string): Promise<ScimUserState> {
    const identity = await client.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId: resourceId } } });
    if (identity === null || identity.kind !== "user" || identity.userId === null) throw scimError(404, "The SCIM user does not exist", "noTarget");
    const user = await client.user.findUnique({ where: { id: identity.userId }, select: { id: true, loginIdentifier: true, status: true } });
    const membership = await client.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId, userId: identity.userId } }, select: { status: true } });
    if (user === null || membership === null) throw scimError(404, "The SCIM user does not exist", "noTarget");
    return { externalId: identity.externalId, lastSyncedAt: identity.lastSyncedAt, user, membership };
  }

  /** 读取 SCIM 组映射和组状态，资源不存在时不泄露其他组织的组信息。 */
  async #loadScimGroupState(client: ScimReadClient, organizationId: string, resourceId: string): Promise<ScimGroupState> {
    const identity = await client.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId: resourceId } } });
    if (identity === null || identity.kind !== "group" || identity.groupId === null) throw scimError(404, "The SCIM group does not exist", "noTarget");
    const group = await client.userGroup.findFirst({ where: { id: identity.groupId, organizationId }, select: { id: true, name: true, status: true } });
    if (group === null || group.status !== "active") throw scimError(404, "The SCIM group does not exist", "noTarget");
    return { externalId: identity.externalId, group, lastSyncedAt: identity.lastSyncedAt };
  }

  /** 将组成员关系投影为 SCIM 用户资源 ID，未被 SCIM 映射的内部成员不会伪造外部 ID。 */
  async #scimGroupMembers(client: ScimReadClient, organizationId: string, groupId: string): Promise<ScimGroupResource["members"]> {
    const memberships = await client.userGroupMembership.findMany({ where: { organizationId, groupId }, select: { userId: true, user: { select: { loginIdentifier: true } } }, orderBy: { userId: "asc" } });
    if (memberships.length === 0) return [];
    const identities = await client.scimExternalIdentity.findMany({ where: { organizationId, kind: "user", userId: { in: memberships.map((membership) => membership.userId) } }, select: { externalId: true, userId: true } });
    const identityByUserId = new Map(identities.flatMap((identity) => identity.userId === null ? [] : [[identity.userId, identity.externalId] as const]));
    return memberships.flatMap((membership) => {
      const externalId = identityByUserId.get(membership.userId);
      return externalId === undefined ? [] : [{ display: membership.user.loginIdentifier, type: "User" as const, value: externalId }];
    });
  }

  /** 标准 SCIM 用户 upsert 的唯一状态入口；调用者必须已处于组织令牌事务内。 */
  async #upsertScimUser(transaction: Prisma.TransactionClient, organizationId: string, input: ScimUserRequest, requestId: string): Promise<void> {
    const now = new Date();
    const externalId = input.externalId ?? input.userName;
    const active = input.active ?? true;
    const existing = await transaction.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId } } });
    if (existing !== null && existing.kind !== "user") throw scimError(409, "The externalId is already assigned to a group", "uniqueness");
    const user = existing?.userId === null || existing?.userId === undefined
      ? await transaction.user.upsert({ where: { loginIdentifier: input.userName }, create: { loginIdentifier: input.userName, passwordDigest: null, status: "active" }, update: { loginIdentifier: input.userName } })
      : await transaction.user.update({ where: { id: existing.userId }, data: { loginIdentifier: input.userName } });
    await transaction.organizationMembership.upsert({ where: { organizationId_userId: { organizationId, userId: user.id } }, create: { organizationId, userId: user.id, role: "member", status: active ? "active" : "inactive" }, update: { status: active ? "active" : "inactive" } });
    await transaction.scimExternalIdentity.upsert({ where: { organizationId_externalId: { organizationId, externalId } }, create: { organizationId, externalId, kind: "user", userId: user.id, groupId: null, lastSyncedAt: now }, update: { kind: "user", userId: user.id, groupId: null, lastSyncedAt: now } });
    if (!active) await this.#setScimUserActive(transaction, organizationId, user.id, false, requestId);
  }

  /** 停用用户时统一撤销会话与机器凭据，并发布现有连接关闭事件。 */
  async #setScimUserActive(transaction: Prisma.TransactionClient, organizationId: string, userId: string, active: boolean, requestId: string): Promise<void> {
    const now = new Date();
    await transaction.organizationMembership.updateMany({ where: { organizationId, userId }, data: { status: active ? "active" : "inactive" } });
    await transaction.scimExternalIdentity.updateMany({ where: { organizationId, kind: "user", userId }, data: { lastSyncedAt: now } });
    await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: now, organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: userId, targetType: "membership" });
    if (active) return;
    const revokedSessions = await transaction.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await transaction.enterpriseApiKey.updateMany({ where: { organizationId, userId, revokedAt: null }, data: { revokedAt: now } });
    if (revokedSessions.count > 0) await this.accessChanges.publish(transaction, { kind: "close", reason: "forbidden", requestId, selectors: [{ kind: "user", value: userId }] });
  }

  /** 标准 SCIM 组 upsert 的唯一状态入口，externalId 未提供时使用 displayName 作为稳定资源键。 */
  async #upsertScimGroup(transaction: Prisma.TransactionClient, organizationId: string, input: ScimGroupRequest): Promise<ScimGroupState> {
    const now = new Date();
    const externalId = input.externalId ?? input.displayName;
    const existing = await transaction.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId } } });
    if (existing !== null && existing.kind !== "group") throw scimError(409, "The externalId is already assigned to a user", "uniqueness");
    const group = existing?.groupId === null || existing?.groupId === undefined
      ? await transaction.userGroup.upsert({ where: { organizationId_name: { organizationId, name: input.displayName } }, create: { organizationId, name: input.displayName, status: "active" }, update: { name: input.displayName, status: "active" }, select: { id: true, name: true, status: true } })
      : await transaction.userGroup.update({ where: { id: existing.groupId }, data: { name: input.displayName, status: "active" }, select: { id: true, name: true, status: true } });
    await transaction.scimExternalIdentity.upsert({ where: { organizationId_externalId: { organizationId, externalId } }, create: { organizationId, externalId, kind: "group", userId: null, groupId: group.id, lastSyncedAt: now }, update: { kind: "group", userId: null, groupId: group.id, lastSyncedAt: now } });
    return { externalId, group, lastSyncedAt: now };
  }

  /** 验证并解析成员资源 ID；成员资源必须来自同一组织的 SCIM Users。 */
  #scimPatchMemberIds(operation: ScimPatchRequest["Operations"][number], path: string): string[] {
    if (path !== "members") {
      const match = /^members\[value eq "([^"]+)"\]$/.exec(path);
      if (match === null) throw scimError(400, "The members filter is invalid", "invalidPath");
      return [match[1]!];
    }
    if (!Array.isArray(operation.value) || !operation.value.every((value) => typeof value === "object" && value !== null && "value" in value && typeof (value as { readonly value?: unknown }).value === "string")) throw scimError(400, "The members value must be a SCIM user list", "invalidValue");
    return operation.value.map((value) => (value as { value: string }).value);
  }

  /** 用目标成员集合替换组成员，并复用数据库唯一约束保证幂等。 */
  async #replaceScimGroupMembers(transaction: Prisma.TransactionClient, organizationId: string, groupId: string, memberIds: readonly string[], requestId: string): Promise<void> {
    await this.#removeScimGroupMembers(transaction, organizationId, groupId, [], requestId, true);
    await this.#addScimGroupMembers(transaction, organizationId, groupId, memberIds, requestId);
  }

  /** 增加组成员；外部资源 ID 解析只在本事务中完成一次。 */
  async #addScimGroupMembers(transaction: Prisma.TransactionClient, organizationId: string, groupId: string, memberIds: readonly string[], requestId: string): Promise<void> {
    const identities = await transaction.scimExternalIdentity.findMany({ where: { organizationId, kind: "user", externalId: { in: [...memberIds] }, userId: { not: null } }, select: { externalId: true, userId: true } });
    if (identities.length !== new Set(memberIds).size) throw scimError(404, "A SCIM group member does not exist", "noTarget");
    const userIds = identities.flatMap((identity) => identity.userId === null ? [] : [identity.userId]);
    await transaction.userGroupMembership.createMany({ data: userIds.map((userId) => ({ organizationId, groupId, userId })), skipDuplicates: true });
    await this.#publishScimGroupAccessChanges(transaction, organizationId, groupId, userIds, requestId);
    if (userIds.length > 0) await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: groupId, targetType: "group" });
  }

  /** 移除组成员；空列表仅用于替换操作清空全部关系。 */
  async #removeScimGroupMembers(transaction: Prisma.TransactionClient, organizationId: string, groupId: string, memberIds: readonly string[], requestId: string, clearAll = false): Promise<void> {
    const userIds = clearAll
      ? (await transaction.userGroupMembership.findMany({ where: { organizationId, groupId }, select: { userId: true } })).map((membership) => membership.userId)
      : (await transaction.scimExternalIdentity.findMany({ where: { organizationId, kind: "user", externalId: { in: [...memberIds] }, userId: { not: null } }, select: { userId: true } })).flatMap((identity) => identity.userId === null ? [] : [identity.userId]);
    if (!clearAll && userIds.length !== new Set(memberIds).size) throw scimError(404, "A SCIM group member does not exist", "noTarget");
    const where = clearAll ? { organizationId, groupId } : { organizationId, groupId, userId: { in: userIds } };
    const removed = await transaction.userGroupMembership.deleteMany({ where });
    await this.#publishScimGroupAccessChanges(transaction, organizationId, groupId, userIds, requestId);
    if (removed.count > 0) await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: groupId, targetType: "group" });
  }

  /** 让组成员变化立即失效受影响空间连接；正文和文档 ACL 仍由既有权限 owner 计算。 */
  async #publishScimGroupAccessChanges(transaction: Prisma.TransactionClient, organizationId: string, groupId: string, userIds: readonly string[], requestId: string): Promise<void> {
    if (userIds.length === 0) return;
    const grants = await transaction.spaceGroupGrant.findMany({ where: { organizationId, groupId, space: { status: "active" } }, select: { spaceId: true }, distinct: ["spaceId"] });
    for (const space of grants) {
      for (const userId of userIds) {
        await this.accessChanges.publish(transaction, { kind: "close", reason: "forbidden", requestId, selectors: [{ kind: "space", value: space.spaceId }, { kind: "user", value: userId }] });
      }
    }
  }

  /** 保存 Draw.io/Excalidraw 元数据并保持正文可读；嵌入失败只改变嵌入状态，不写入正文。 */
  async upsertEmbed(actorUserId: string, scope: DocumentScope, input: GovernanceEmbeddedObjectRequest, requestId: string) {
    const embed = await this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "editor");
      await this.#requireGovernanceEnabled(transaction, scope.organizationId, scope.spaceId);
      const existing = await transaction.embeddedObject.findFirst({ where: { ...scope, kind: input.kind, status: { not: "deleted" } }, orderBy: { version: "desc" } });
      const updated = existing === null
        ? await transaction.embeddedObject.create({ data: { ...scope, kind: input.kind, payload: input.payload as Prisma.InputJsonObject, status: "active", createdByUserId: actorUserId } })
        : await transaction.embeddedObject.update({ where: { id: existing.id }, data: { payload: input.payload as Prisma.InputJsonObject, status: "active", version: { increment: 1 } } });
      await this.audit.append(transaction, { action: "content.edit", actorUserId, occurredAt: new Date(), organizationId: scope.organizationId, outcome: "succeeded", requestId, spaceId: scope.spaceId, targetId: scope.documentId, targetType: "document" });
      return updated;
    });
    this.#logger.log({ event: "content.embed.updated", organizationId: scope.organizationId, spaceId: scope.spaceId, documentId: scope.documentId, embedId: embed.id, requestId });
    return { embedId: embed.id, kind: embed.kind, payload: embed.payload, status: embed.status, version: embed.version };
  }

  /** 读取当前文档的可用嵌入元数据，正文和嵌入渲染状态仍由 Kernel/前端消费。 */
  async listEmbeds(actorUserId: string, scope: DocumentScope) {
    const embeds = await this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "viewer");
      return transaction.embeddedObject.findMany({ where: { ...scope, status: { not: "deleted" } }, orderBy: { updatedAt: "desc" } });
    });
    return { embeds };
  }

  /** AI 先按四段身份读取当前文档内容，provider 返回后再次复验内容，禁止用问题关键词推断文档。 */
  async askAi(
    actorUserId: string,
    scope: DocumentScope,
    input: AiChatRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<AiChatResponse> {
    await this.access.requireDocumentRole({ ...scope, actorUserId }, "viewer");
    const source = await this.discovery.readDocumentContent({
      actorUserId,
      documentId: scope.documentId,
      notebookId: scope.notebookId,
      organizationId: scope.organizationId,
      requestId,
      signal,
      spaceId: scope.spaceId,
    });
    const conversation = await this.database.client.$transaction(async (transaction) => {
      const currentConversation = input.conversationId === undefined
        ? await transaction.aiConversation.create({ data: { organizationId: scope.organizationId, userId: actorUserId } })
        : await transaction.aiConversation.findFirst({ where: { id: input.conversationId, organizationId: scope.organizationId, userId: actorUserId } });
      if (currentConversation === null) {
        throw notFound();
      }
      return currentConversation;
    });
    let answer: string;
    try {
      const completion = await this.aiProvider.complete({
        context: [{ excerpt: source.content, title: source.title }],
        query: input.query,
      });
      answer = completion.answer;
    } catch (error) {
      this.#logger.error({ documentId: scope.documentId, error, event: "ai.chat", organizationId: scope.organizationId, outcome: "provider-failed", requestId, spaceId: scope.spaceId });
      throw error;
    }
    await this.access.requireDocumentRole({ ...scope, actorUserId }, "viewer");
    const verified = await this.discovery.readDocumentContent({
      actorUserId,
      documentId: scope.documentId,
      notebookId: scope.notebookId,
      organizationId: scope.organizationId,
      requestId,
      signal,
      spaceId: scope.spaceId,
    });
    if (
      verified.documentId !== scope.documentId ||
      verified.notebookId !== scope.notebookId ||
      verified.content !== source.content
    ) {
      throw conflict();
    }
    const promptDigest = createHash("sha256").update(input.query).digest("hex");
    const persisted = await this.database.client.$transaction(async (transaction) => {
      await transaction.aiMessage.create({ data: { content: `[query-digest:${promptDigest}]`, conversationId: conversation.id, role: "user" } });
      const message = await transaction.aiMessage.create({ data: { content: answer, conversationId: conversation.id, role: "assistant" } });
      await transaction.aiCitation.create({ data: { documentId: scope.documentId, excerpt: verified.content, messageId: message.id, notebookId: scope.notebookId, organizationId: scope.organizationId, spaceId: scope.spaceId, verifiedAt: new Date() } });
      await transaction.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      return message;
    });
    return { answer, citations: [{ document: { documentId: scope.documentId, notebookId: scope.notebookId, organizationId: scope.organizationId, spaceId: scope.spaceId }, excerpt: verified.content }], conversationId: conversation.id, messageId: persisted.id };
  }

  /** 以显式幂等键登记治理任务，重复调度只返回同一控制面事实。 */
  async enqueueTask(scope: DocumentScope, kind: "verify" | "archive" | "retain" | "export_watermark", versionToken: string) {
    return this.database.client.$transaction(async (transaction) => {
      await this.#requireGovernanceEnabled(transaction, scope.organizationId, scope.spaceId);
      return this.#queueTask(transaction, scope, kind, versionToken);
    });
  }

  /** 记录任务原始异常链，供运维重试和审计查询；不得只保留 message 摘要。 */
  async recordTaskFailure(taskId: string, error: unknown): Promise<void> {
    const failure = error instanceof Error ? error : new Error("Non-Error governance task failure", { cause: error });
    this.#logger.error({ event: "governance.task.failed", error: failure, taskId });
    await this.database.client.governanceTask.update({ where: { id: taskId }, data: { status: "failed", lastErrorName: failure.name, lastErrorMessage: failure.message, lastErrorStack: failure.stack ?? failure.message, attempts: { increment: 1 } } });
  }

  /** 创建未启用的 MFA 因子；TOTP 秘钥在进入数据库前用独立 AES-GCM 密钥加密。 */
  async enrollMfa(actorUserId: string, input: MfaFactorRequest, requestId: string) {
    return this.mfa.enroll(actorUserId, input, requestId);
  }

  /** 读取 MFA 因子摘要，供用户设置页展示当前绑定状态。 */
  async listMfaFactors(actorUserId: string) {
    return this.mfa.listFactors(actorUserId);
  }

  /** 使用 RFC 6238 窗口验证一次性验证码，成功后才把因子标记为启用。 */
  async verifyMfa(actorUserId: string, input: MfaVerifyRequest, requestId: string): Promise<{ enabled: boolean }> {
    return this.mfa.verify(actorUserId, input, requestId);
  }

  #projectPolicy(policy: { id: string; organizationId: string; spaceId: string; verificationIntervalDays: number; verificationGraceDays: number; archiveAfterDays: number; retentionDays: number; defaultClassification: GovernanceClassification; watermarkEnabled: boolean; governanceEnabled: boolean; updatedAt: Date }): GovernancePolicyResponse {
    return { archiveAfterDays: policy.archiveAfterDays, defaultClassification: policy.defaultClassification, governanceEnabled: policy.governanceEnabled, organizationId: policy.organizationId, policyId: policy.id, retentionDays: policy.retentionDays, spaceId: policy.spaceId, updatedAt: policy.updatedAt.toISOString(), verificationGraceDays: policy.verificationGraceDays, verificationIntervalDays: policy.verificationIntervalDays, watermarkEnabled: policy.watermarkEnabled };
  }

  #projectDocument(document: { organizationId: string; spaceId: string; notebookId: string; documentId: string; lifecycle: string; verification: string; classification: GovernanceClassification; ownerUserId: string | null; currentVersion: string | null; nextVerificationAt: Date | null; archivedAt: Date | null; retentionUntil: Date | null; legalHold: boolean }): DocumentGovernance {
    return { classification: document.classification, document: { organizationId: document.organizationId, spaceId: document.spaceId, notebookId: document.notebookId, documentId: document.documentId }, legalHold: document.legalHold, lifecycle: lifecycleToContract[document.lifecycle]!, verification: verificationToContract[document.verification]!, ...(document.ownerUserId === null ? {} : { ownerUserId: document.ownerUserId }), ...(document.currentVersion === null ? {} : { currentVersion: document.currentVersion }), ...(document.nextVerificationAt === null ? {} : { nextVerificationAt: document.nextVerificationAt.toISOString() }), ...(document.archivedAt === null ? {} : { archivedAt: document.archivedAt.toISOString() }), ...(document.retentionUntil === null ? {} : { retentionUntil: document.retentionUntil.toISOString() }) };
  }

  #projectTemplate(template: { id: string; name: string; description: string | null; initialContent: Prisma.JsonValue; defaultClassification: GovernanceClassification; verificationIntervalDays: number; status: string; updatedAt: Date }) {
    return { defaultClassification: template.defaultClassification, ...(template.description === null ? {} : { description: template.description }), initialContent: template.initialContent as Record<string, unknown>, name: template.name, status: template.status, templateId: template.id, updatedAt: template.updatedAt.toISOString(), verificationIntervalDays: template.verificationIntervalDays };
  }

  #nextLifecycle(current: string, action: GovernanceTransitionRequest["action"]): string {
    const allowed: Record<string, Partial<Record<GovernanceTransitionRequest["action"], string>>> = {
      draft: { submit: "in_review" },
      in_review: { approve: "approved", reject: "rejected" },
      approved: { publish: "published", reject: "rejected" },
      published: { archive: "archived" },
      archived: { restore: "draft" },
      rejected: { submit: "in_review" },
    };
    const next = allowed[current]?.[action];
    if (next === undefined && action !== "verify") {
      throw conflict();
    }
    return next ?? current;
  }

  async #documentGovernanceData(transaction: Prisma.TransactionClient, actorUserId: string, scope: DocumentScope, now: Date) {
    const policy = await transaction.governancePolicy.findUnique({ where: { organizationId_spaceId: { organizationId: scope.organizationId, spaceId: scope.spaceId } } });
    return { ...scope, classification: policy?.defaultClassification ?? "internal", lifecycle: "draft" as const, verification: "needs_review" as const, ownerUserId: actorUserId, ...(policy === null ? {} : { nextVerificationAt: new Date(now.getTime() + policy.verificationIntervalDays * 86_400_000), retentionUntil: new Date(now.getTime() + policy.retentionDays * 86_400_000) }) };
  }

  async createDocumentGovernance(transaction: Prisma.TransactionClient, actorUserId: string, scope: DocumentScope, now: Date) {
    return transaction.documentGovernance.create({ data: await this.#documentGovernanceData(transaction, actorUserId, scope, now) });
  }

  /** 用四段身份、任务类型和版本组成唯一键，重复调度只更新可执行时间而不创建副作用。 */
  async #queueTask(transaction: Prisma.TransactionClient, scope: DocumentScope, kind: "verify" | "archive" | "retain" | "export_watermark", versionToken: string) {
    const idempotencyKey = `governance:${kind}:${scope.organizationId}:${scope.spaceId}:${scope.notebookId}:${scope.documentId}:${versionToken}`;
    const task = await transaction.governanceTask.upsert({
      where: { idempotencyKey },
      create: { ...scope, kind, status: "queued", idempotencyKey },
      update: { status: "queued", availableAt: new Date() },
    });
    const pending = await transaction.workerJob.findFirst({ where: { organizationId: scope.organizationId, kind: "governance_task", status: { in: ["queued", "running"] }, payload: { path: ["taskId"], equals: task.id } } });
    if (pending === null) {
      await transaction.workerJob.create({
        data: {
          organizationId: scope.organizationId,
          kind: "governance_task",
          status: "queued",
          payload: { documentId: scope.documentId, notebookId: scope.notebookId, spaceId: scope.spaceId, taskId: task.id, taskKind: kind },
          requestId: randomUUID(),
          availableAt: new Date(),
        },
      });
    }
    return task;
  }

  /** 治理 mutation 的唯一开关 owner；策略读写保留开放以支持灰度与安全回滚。 */
  async #requireGovernanceEnabled(transaction: Prisma.TransactionClient, organizationId: string, spaceId: string): Promise<void> {
    const policy = await transaction.governancePolicy.findUnique({
      where: { organizationId_spaceId: { organizationId, spaceId } },
      select: { governanceEnabled: true },
    });
    if (policy === null || !policy.governanceEnabled) {
      throw forbidden();
    }
  }
}
