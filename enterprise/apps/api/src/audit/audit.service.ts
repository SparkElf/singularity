import { Injectable } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { OrganizationManagementService } from "../organizations/organization-management.service.js";
import { SpaceManagementService } from "../spaces/space-management.service.js";
import {
  auditEventView,
  type AuditEventRow,
  type AuditEventView,
} from "./audit.types.js";

@Injectable()
export class AuditService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly organizations: OrganizationManagementService,
    private readonly spaces: SpaceManagementService,
  ) {}

  /** 在组织审计链上按游标读取事件，保持顺序、分页边界和完整校验字段。 */
  async listOrganizationEvents(input: {
    actorUserId: string;
    beforeSequence: bigint | null;
    limit: number;
    organizationId: string;
  }): Promise<AuditEventView[]> {
    return this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
      );
      return this.#query(
        transaction,
        input.organizationId,
        null,
        input.beforeSequence,
        input.limit,
      );
    });
  }

  /** 在空间审计链上按游标读取事件，先锁定空间归属再投影最小事件视图。 */
  async listSpaceEvents(input: {
    actorUserId: string;
    beforeSequence: bigint | null;
    limit: number;
    organizationId: string;
    spaceId: string;
  }): Promise<AuditEventView[]> {
    return this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
        input.spaceId,
      );
      return this.#query(
        transaction,
        input.organizationId,
        input.spaceId,
        input.beforeSequence,
        input.limit,
      );
    });
  }

  /** 复用统一审计查询和 MAC 校验逻辑，避免组织与空间入口产生不同链路。 */
  async #query(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    spaceId: string | null,
    beforeSequence: bigint | null,
    limit: number,
  ): Promise<AuditEventView[]> {
    const rows = await transaction.$queryRaw<AuditEventRow[]>(
      Prisma.sql`
        SELECT
          "id" AS "auditEventId",
          "organization_id" AS "organizationId",
          "sequence",
          "space_id" AS "spaceId",
          "actor_user_id" AS "actorUserId",
          "action",
          "target_type" AS "targetType",
          "target_id" AS "targetId",
          "outcome",
          "occurred_at" AS "occurredAt",
          "request_id" AS "requestId",
          "previous_mac" AS "previousMac",
          "mac",
          "key_version" AS "keyVersion"
        FROM "audit_events"
        WHERE "organization_id" = ${organizationId}::uuid
          AND (${spaceId}::uuid IS NULL OR "space_id" = ${spaceId}::uuid)
          AND (${beforeSequence}::bigint IS NULL OR "sequence" < ${beforeSequence}::bigint)
        ORDER BY "sequence" DESC
        LIMIT ${limit}
      `,
    );
    return rows.map(auditEventView);
  }
}
