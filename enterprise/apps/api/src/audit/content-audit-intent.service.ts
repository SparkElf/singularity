import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ContentAuditAction } from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import type { ApiConfiguration } from "../configuration.js";
import type { Clock } from "../identity/clock.js";
import { API_CONFIGURATION, CLOCK } from "../tokens.js";

export type ObservedContentAuditOutcome = "failed" | "succeeded";

@Injectable()
export class ContentAuditIntentService {
  readonly #logger = new Logger("ContentAuditIntent");

  constructor(
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly database: DatabaseRuntime,
  ) {}

  async prepare(input: {
    action: ContentAuditAction;
    actorUserId: string;
    documentId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<void> {
    const occurredAt = this.clock.now();
    const availableAt = new Date(
      occurredAt.getTime() +
        this.configuration.contentAuditIndeterminateAfterMilliseconds,
    );
    await this.database.client.$executeRaw(
      Prisma.sql`
        INSERT INTO "content_audit_intents" (
          "request_id", "organization_id", "space_id", "actor_user_id",
          "action", "document_id", "occurred_at", "observed_outcome",
          "available_at"
        ) VALUES (
          ${input.requestId}::uuid, ${input.organizationId}::uuid,
          ${input.spaceId}::uuid, ${input.actorUserId}::uuid,
          ${input.action}::"audit_action", ${input.documentId},
          ${occurredAt}, NULL, ${availableAt}
        )
      `,
    );
    this.#logger.log({
      action: input.action,
      availableAt: availableAt.toISOString(),
      documentId: input.documentId,
      event: "content.audit-intent",
      organizationId: input.organizationId,
      outcome: "prepared",
      requestId: input.requestId,
      spaceId: input.spaceId,
    });
  }

  async resolve(input: {
    outcome: ObservedContentAuditOutcome;
    requestId: string;
  }): Promise<boolean> {
    const observedAt = this.clock.now();
    const updated = await this.database.client.$executeRaw(
      Prisma.sql`
        UPDATE "content_audit_intents"
        SET
          "observed_outcome" = ${input.outcome}::"audit_outcome",
          "available_at" = ${observedAt}
        WHERE "request_id" = ${input.requestId}::uuid
          AND "observed_outcome" IS NULL
      `,
    );
    this.#logger.log({
      event: "content.audit-resolution",
      outcome: updated === 1 ? input.outcome : "late",
      requestId: input.requestId,
    });
    return updated === 1;
  }
}
