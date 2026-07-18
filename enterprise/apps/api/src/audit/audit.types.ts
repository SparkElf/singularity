import type {
  AuditAction,
  AuditEventView,
  AuditOutcome,
  AuditTargetType,
} from "@singularity/contracts";

export { auditActions } from "@singularity/contracts";
export type { AuditAction, AuditEventView, AuditOutcome };

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

export interface AuditEventRow {
  action: AuditAction;
  actorUserId: string | null;
  auditEventId: string;
  keyVersion: string;
  mac: string;
  occurredAt: Date;
  organizationId: string;
  outcome: AuditOutcome;
  previousMac: string | null;
  requestId: string;
  sequence: bigint;
  spaceId: string | null;
  targetId: string;
  targetType: AuditTargetType;
}

export function auditEventView(row: AuditEventRow): AuditEventView {
  return {
    action: row.action,
    actorUserId: row.actorUserId,
    auditEventId: row.auditEventId,
    keyVersion: row.keyVersion,
    mac: row.mac,
    occurredAt: row.occurredAt.toISOString(),
    organizationId: row.organizationId,
    outcome: row.outcome,
    previousMac: row.previousMac,
    requestId: row.requestId,
    sequence: row.sequence.toString(),
    spaceId: row.spaceId,
    targetId: row.targetId,
    targetType: row.targetType,
  };
}
