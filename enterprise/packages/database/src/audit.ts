import {
  createHmac,
  createSecretKey,
  randomUUID,
  type KeyObject,
} from "node:crypto";

import type {
  AuditAction,
  AuditOutcome,
  AuditTargetType,
} from "@singularity/contracts";

import { Prisma } from "./generated/prisma/client.js";

export interface AuditConfiguration {
  hmacKey: KeyObject;
  keyVersion: string;
}

export interface AuditConfigurationEnvironment {
  readonly SINGULARITY_AUDIT_HMAC_KEY?: string;
  readonly SINGULARITY_AUDIT_KEY_VERSION?: string;
}

export class AuditConfigurationError extends Error {
  constructor(options?: ErrorOptions) {
    super("Audit configuration is unavailable", options);
    this.name = "AuditConfigurationError";
  }
}

export function parseAuditConfiguration(
  environment: AuditConfigurationEnvironment,
): AuditConfiguration {
  const encoded = environment.SINGULARITY_AUDIT_HMAC_KEY;
  const keyVersion = environment.SINGULARITY_AUDIT_KEY_VERSION;
  if (
    encoded === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    keyVersion === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyVersion)
  ) {
    throw new AuditConfigurationError();
  }
  let key: Buffer;
  try {
    key = Buffer.from(encoded, "base64url");
  } catch (error) {
    throw new AuditConfigurationError({ cause: error });
  }
  if (
    key.byteLength < 32 ||
    key.byteLength > 128 ||
    key.toString("base64url") !== encoded
  ) {
    throw new AuditConfigurationError();
  }
  return { hmacKey: createSecretKey(key), keyVersion };
}

export interface AppendAuditEvent {
  action: AuditAction;
  actorUserId: string | null;
  occurredAt: Date;
  organizationId: string;
  outcome: AuditOutcome;
  requestId: string;
  spaceId: string | null;
  targetId: string;
  targetType: AuditTargetType;
}

interface AuditSequenceRow {
  lastMac: string | null;
  lastSequence: bigint;
}

export class AuditWriter {
  readonly #hmacKey: KeyObject;
  readonly #keyVersion: string;

  constructor(configuration: AuditConfiguration) {
    this.#hmacKey = configuration.hmacKey;
    this.#keyVersion = configuration.keyVersion;
  }

  async appendPermissionChange(
    transaction: Prisma.TransactionClient,
    input: Omit<AppendAuditEvent, "action" | "outcome">,
  ): Promise<void> {
    await this.append(transaction, {
      ...input,
      action: "permission.change",
      outcome: "succeeded",
    });
  }

  async append(
    transaction: Prisma.TransactionClient,
    input: AppendAuditEvent,
  ): Promise<void> {
    await transaction.$executeRaw(
      Prisma.sql`
        INSERT INTO "organization_audit_sequences" (
          "organization_id", "last_sequence", "last_mac"
        ) VALUES (${input.organizationId}::uuid, 0, NULL)
        ON CONFLICT ("organization_id") DO NOTHING
      `,
    );
    const states = await transaction.$queryRaw<AuditSequenceRow[]>(
      Prisma.sql`
        SELECT
          "last_sequence" AS "lastSequence",
          "last_mac" AS "lastMac"
        FROM "organization_audit_sequences"
        WHERE "organization_id" = ${input.organizationId}::uuid
        FOR UPDATE
      `,
    );
    const state = states[0];
    if (state === undefined) {
      throw new Error("Audit sequence is unavailable");
    }

    const auditEventId = randomUUID();
    const sequence = state.lastSequence + 1n;
    const mac = createHmac("sha256", this.#hmacKey)
      .update(
        JSON.stringify([
          "singularity.audit-event.v1",
          auditEventId,
          input.organizationId,
          sequence.toString(),
          state.lastMac,
          input.spaceId,
          input.actorUserId,
          input.action,
          input.targetType,
          input.targetId,
          input.outcome,
          input.occurredAt.toISOString(),
          input.requestId,
          this.#keyVersion,
        ]),
        "utf8",
      )
      .digest("hex");

    await transaction.$executeRaw(
      Prisma.sql`
        INSERT INTO "audit_events" (
          "id", "organization_id", "sequence", "space_id", "actor_user_id",
          "action", "target_type", "target_id", "outcome", "occurred_at",
          "request_id", "previous_mac", "mac", "key_version"
        ) VALUES (
          ${auditEventId}::uuid, ${input.organizationId}::uuid, ${sequence},
          ${input.spaceId}::uuid, ${input.actorUserId}::uuid,
          ${input.action}::"audit_action",
          ${input.targetType}, ${input.targetId},
          ${input.outcome}::"audit_outcome",
          ${input.occurredAt}, ${input.requestId}::uuid, ${state.lastMac},
          ${mac}, ${this.#keyVersion}
        )
      `,
    );
    await transaction.$executeRaw(
      Prisma.sql`
        UPDATE "organization_audit_sequences"
        SET "last_sequence" = ${sequence}, "last_mac" = ${mac}
        WHERE "organization_id" = ${input.organizationId}::uuid
      `,
    );
  }
}
