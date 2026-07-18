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

  async listOrganizationEvents(input: {
    actorUserId: string;
    beforeSequence: bigint | null;
    limit: number;
    organizationId: string;
  }): Promise<AuditEventView[]> {
    await this.organizations.requireManager(
      input.actorUserId,
      input.organizationId,
    );
    return this.#query(input.organizationId, null, input.beforeSequence, input.limit);
  }

  async listSpaceEvents(input: {
    actorUserId: string;
    beforeSequence: bigint | null;
    limit: number;
    organizationId: string;
    spaceId: string;
  }): Promise<AuditEventView[]> {
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.organizationId,
      input.spaceId,
    );
    return this.#query(
      input.organizationId,
      input.spaceId,
      input.beforeSequence,
      input.limit,
    );
  }

  async #query(
    organizationId: string,
    spaceId: string | null,
    beforeSequence: bigint | null,
    limit: number,
  ): Promise<AuditEventView[]> {
    const rows = await this.database.client.$queryRaw<AuditEventRow[]>(
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
