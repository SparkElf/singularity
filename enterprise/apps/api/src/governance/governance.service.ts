import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
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
  MfaFactorRequest,
  MfaVerifyRequest,
  AiChatRequest,
  AiChatResponse,
} from "@singularity/contracts";
import { $Enums, AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { ContentDirectoryService } from "../kernel/content-directory.service.js";
import { OrganizationManagementService } from "../organizations/organization-management.service.js";
import { SpaceManagementService } from "../spaces/space-management.service.js";
import { SpaceAccessService } from "../spaces/space-access.service.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { conflict, forbidden, notFound, unauthenticated } from "../problem.js";
import { MfaService } from "../identity/mfa.service.js";
import { AI_PROVIDER } from "../tokens.js";
import type { AiProvider } from "./ai-provider.js";

interface DocumentScope {
  readonly organizationId: string;
  readonly spaceId: string;
  readonly notebookId: string;
  readonly documentId: string;
}

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

  /** 在同一授权事务内读取索引并按四段身份过滤，避免跨空间串库和文档侧信道。 */
  async search(actorUserId: string, organizationId: string, input: GovernanceSearchRequest) {
    const requestedSpaceIds = [...new Set(input.spaceIds)];
    if (requestedSpaceIds.length === 0) {
      return { results: [] };
    }
    const results = await this.database.client.$transaction(async (transaction) => {
      const rows = await transaction.searchDocumentIndex.findMany({
        where: {
          organizationId,
          spaceId: { in: requestedSpaceIds },
          OR: [{ title: { contains: input.query, mode: "insensitive" } }, { excerpt: { contains: input.query, mode: "insensitive" } }],
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      const visibleKeys = new Set<string>();
      for (const spaceId of requestedSpaceIds) {
        const documents = rows.filter((row) => row.spaceId === spaceId).map((row) => ({ documentId: row.documentId, notebookId: row.notebookId }));
        const visible = await this.access.filterVisibleDocumentsInTransaction(transaction, { actorUserId, documents, organizationId, spaceId });
        for (const document of visible) {
          visibleKeys.add(`${spaceId}:${document.notebookId}:${document.documentId}`);
        }
      }
      return rows.filter((row) => visibleKeys.has(`${row.spaceId}:${row.notebookId}:${row.documentId}`)).map((row) => ({ classification: row.classification, document: { organizationId, spaceId: row.spaceId, notebookId: row.notebookId, documentId: row.documentId }, excerpt: row.excerpt, title: row.title, updatedAt: row.updatedAt.toISOString() }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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

  /** SCIM 同步按 externalId 幂等 upsert，停用成员只收敛账号/会话状态，不推导或写入文档权限。 */
  async syncScim(organizationId: string, input: ScimSyncRequest, requestId: string): Promise<{ groups: number; users: number }> {
    return this.database.client.$transaction(async (transaction) => {
      for (const incoming of input.users) {
        const existing = await transaction.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId: incoming.externalId } } });
        if (existing !== null && existing.kind !== "user") {
          throw conflict();
        }
        const user = existing?.userId === undefined || existing?.userId === null
          ? await transaction.user.upsert({ where: { loginIdentifier: incoming.loginIdentifier }, create: { loginIdentifier: incoming.loginIdentifier, passwordDigest: null, status: incoming.active ? "active" : "disabled" }, update: { status: incoming.active ? "active" : "disabled", loginIdentifier: incoming.loginIdentifier } })
          : await transaction.user.update({ where: { id: existing.userId }, data: { status: incoming.active ? "active" : "disabled", loginIdentifier: incoming.loginIdentifier } });
        await transaction.organizationMembership.upsert({ where: { organizationId_userId: { organizationId, userId: user.id } }, create: { organizationId, userId: user.id, role: "member", status: incoming.active ? "active" : "inactive" }, update: { status: incoming.active ? "active" : "inactive" } });
        await transaction.scimExternalIdentity.upsert({ where: { organizationId_externalId: { organizationId, externalId: incoming.externalId } }, create: { organizationId, externalId: incoming.externalId, kind: "user", userId: user.id, groupId: null, lastSyncedAt: new Date() }, update: { kind: "user", userId: user.id, groupId: null, lastSyncedAt: new Date() } });
        if (!incoming.active) {
          const revokedSessions = await transaction.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
          await transaction.enterpriseApiKey.updateMany({ where: { organizationId, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
          if (revokedSessions.count > 0) {
            await this.accessChanges.publish(transaction, { kind: "close", reason: "forbidden", requestId, selectors: [{ kind: "user", value: user.id }] });
          }
        }
      }
      for (const incoming of input.groups) {
        const existing = await transaction.scimExternalIdentity.findUnique({ where: { organizationId_externalId: { organizationId, externalId: incoming.externalId } } });
        if (existing !== null && existing.kind !== "group") {
          throw conflict();
        }
        // 外部 ID 已建立映射时沿用原组更新名称，避免改名产生孤儿组或迁移权限。
        const group = existing?.groupId === undefined || existing.groupId === null
          ? await transaction.userGroup.upsert({ where: { organizationId_name: { organizationId, name: incoming.name } }, create: { organizationId, name: incoming.name, status: "active" }, update: { status: "active" } })
          : await transaction.userGroup.update({ where: { id: existing.groupId }, data: { name: incoming.name, status: "active" } });
        await transaction.scimExternalIdentity.upsert({ where: { organizationId_externalId: { organizationId, externalId: incoming.externalId } }, create: { organizationId, externalId: incoming.externalId, kind: "group", userId: null, groupId: group.id, lastSyncedAt: new Date() }, update: { kind: "group", userId: null, groupId: group.id, lastSyncedAt: new Date() } });
      }
      await this.audit.append(transaction, { action: "permission.change", actorUserId: null, occurredAt: new Date(), organizationId, outcome: "succeeded", requestId, spaceId: null, targetId: organizationId, targetType: "organization" });
      return { groups: input.groups.length, users: input.users.length };
    });
  }

  /** 保存 Draw.io/Excalidraw 元数据并保持正文可读；嵌入失败只改变嵌入状态，不写入正文。 */
  async upsertEmbed(actorUserId: string, scope: DocumentScope, input: GovernanceEmbeddedObjectRequest, requestId: string) {
    const embed = await this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "editor");
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

  /** AI provider 未配置时明确失败；禁止返回无引用的猜测答案或通过本地 fallback 绕过授权检索。 */
  async askAi(actorUserId: string, scope: DocumentScope, input: AiChatRequest, requestId: string): Promise<AiChatResponse> {
    const { conversation, source } = await this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(transaction, { ...scope, actorUserId }, "viewer");
      const indexed = await transaction.searchDocumentIndex.findUnique({ where: { organizationId_spaceId_notebookId_documentId: scope } });
      if (indexed === null) {
        throw notFound();
      }
      const currentConversation = input.conversationId === undefined
        ? await transaction.aiConversation.create({ data: { organizationId: scope.organizationId, userId: actorUserId } })
        : await transaction.aiConversation.findFirst({ where: { id: input.conversationId, organizationId: scope.organizationId, userId: actorUserId } });
      if (currentConversation === null) {
        throw notFound();
      }
      return { conversation: currentConversation, source: indexed };
    });
    let answer: string;
    try {
      const completion = await this.aiProvider.complete({
        context: [{ excerpt: source.excerpt, title: source.title }],
        query: input.query,
      });
      answer = completion.answer;
    } catch (error) {
      this.#logger.error({ documentId: scope.documentId, error, event: "ai.chat", organizationId: scope.organizationId, outcome: "provider-failed", requestId, spaceId: scope.spaceId });
      throw error;
    }
    await this.access.requireDocumentRole({ ...scope, actorUserId }, "viewer");
    const promptDigest = createHash("sha256").update(input.query).digest("hex");
    const persisted = await this.database.client.$transaction(async (transaction) => {
      await transaction.aiMessage.create({ data: { content: `[query-digest:${promptDigest}]`, conversationId: conversation.id, role: "user" } });
      const message = await transaction.aiMessage.create({ data: { content: answer, conversationId: conversation.id, role: "assistant" } });
      await transaction.aiCitation.create({ data: { documentId: scope.documentId, excerpt: source.excerpt, messageId: message.id, notebookId: scope.notebookId, organizationId: scope.organizationId, spaceId: scope.spaceId, verifiedAt: new Date() } });
      await transaction.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      return message;
    });
    return { answer, citations: [{ document: { documentId: scope.documentId, notebookId: scope.notebookId, organizationId: scope.organizationId, spaceId: scope.spaceId }, excerpt: source.excerpt }], conversationId: conversation.id, messageId: persisted.id };
  }

  /** 以显式幂等键登记治理任务，重复调度只返回同一控制面事实。 */
  async enqueueTask(scope: DocumentScope, kind: "verify" | "archive" | "retain" | "export_watermark", versionToken: string) {
    return this.database.client.$transaction((transaction) => this.#queueTask(transaction, scope, kind, versionToken));
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
}
