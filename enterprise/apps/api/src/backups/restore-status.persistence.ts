import {
  unactivatedSpaceRestoreStatuses,
  type SpaceRestoreStatus,
} from "@singularity/contracts";

type PrismaSpaceRestoreStatus =
  | Exclude<SpaceRestoreStatus, "ready-for-activation">
  | "ready_for_activation";

const prismaStatusByPublicStatus = {
  activated: "activated",
  failed: "failed",
  queued: "queued",
  "ready-for-activation": "ready_for_activation",
  restoring: "restoring",
} as const satisfies Record<SpaceRestoreStatus, PrismaSpaceRestoreStatus>;

export const unactivatedSpaceRestorePersistenceStatuses: readonly PrismaSpaceRestoreStatus[] =
  unactivatedSpaceRestoreStatuses.map(
    (status) => prismaStatusByPublicStatus[status],
  );
