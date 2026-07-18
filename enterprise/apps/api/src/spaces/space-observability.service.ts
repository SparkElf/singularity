import { Inject, Injectable } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";
import type { SpaceObservabilityView } from "@singularity/contracts";

import type { Clock } from "../identity/clock.js";
import { CLOCK } from "../tokens.js";
import { SpaceManagementService } from "./space-management.service.js";

const MAX_SAMPLE_AGE_MILLISECONDS = 5 * 60 * 1_000;

interface ObservationRow {
  assetBytes: bigint | null;
  capacityErrorCode: string | null;
  capacitySampledAt: Date | null;
  dataBytes: bigint | null;
  fileCount: bigint | null;
  healthErrorCode: string | null;
  healthSampledAt: Date | null;
  healthStatus: "ready" | "unavailable" | null;
  kernelVersion: string | null;
  sampleDurationMilliseconds: number | null;
}

function healthView(
  row: ObservationRow,
  now: number,
): SpaceObservabilityView["health"] {
  if (row.healthSampledAt === null) {
    return { reason: "no-sample", status: "unavailable" };
  }
  const sampledAt = row.healthSampledAt.toISOString();
  if (
    row.healthErrorCode !== null ||
    row.healthStatus === null ||
    row.kernelVersion === null
  ) {
    return { reason: "sample-failed", sampledAt, status: "unavailable" };
  }
  if (row.healthStatus === "unavailable") {
    return { reason: "kernel-unavailable", sampledAt, status: "unavailable" };
  }
  return {
    kernelVersion: row.kernelVersion,
    sampledAt,
    status:
      now - row.healthSampledAt.getTime() > MAX_SAMPLE_AGE_MILLISECONDS
        ? "stale"
        : "ready",
  };
}

function capacityView(
  row: ObservationRow,
  now: number,
): SpaceObservabilityView["capacity"] {
  if (row.capacitySampledAt === null) {
    return { reason: "no-sample", status: "unavailable" };
  }
  if (
    row.capacityErrorCode !== null ||
    row.dataBytes === null ||
    row.assetBytes === null ||
    row.fileCount === null ||
    row.sampleDurationMilliseconds === null
  ) {
    return { reason: "sample-failed", status: "unavailable" };
  }
  return {
    assetBytes: row.assetBytes.toString(),
    dataBytes: row.dataBytes.toString(),
    fileCount: row.fileCount.toString(),
    sampleDurationMilliseconds: row.sampleDurationMilliseconds,
    sampledAt: row.capacitySampledAt.toISOString(),
    status:
      now - row.capacitySampledAt.getTime() > MAX_SAMPLE_AGE_MILLISECONDS
        ? "stale"
        : "fresh",
  };
}

@Injectable()
export class SpaceObservabilityService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly database: DatabaseRuntime,
    private readonly spaces: SpaceManagementService,
  ) {}

  async read(input: {
    actorUserId: string;
    organizationId: string;
    spaceId: string;
  }): Promise<SpaceObservabilityView> {
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.organizationId,
      input.spaceId,
    );
    const rows = await this.database.client.$queryRaw<ObservationRow[]>(
      Prisma.sql`
        SELECT
          health."status" AS "healthStatus",
          health."kernel_version" AS "kernelVersion",
          health."sampled_at" AS "healthSampledAt",
          health."error_code" AS "healthErrorCode",
          capacity."data_bytes" AS "dataBytes",
          capacity."asset_bytes" AS "assetBytes",
          capacity."file_count" AS "fileCount",
          capacity."sample_duration_milliseconds" AS "sampleDurationMilliseconds",
          capacity."sampled_at" AS "capacitySampledAt",
          capacity."error_code" AS "capacityErrorCode"
        FROM "kernel_instances" AS kernel
        LEFT JOIN LATERAL (
          SELECT "status", "kernel_version", "sampled_at", "error_code"
          FROM "kernel_health_observations"
          WHERE "kernel_instance_id" = kernel."id"
          ORDER BY "sampled_at" DESC
          LIMIT 1
        ) AS health ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            "data_bytes", "asset_bytes", "file_count",
            "sample_duration_milliseconds", "sampled_at", "error_code"
          FROM "space_capacity_observations"
          WHERE "kernel_instance_id" = kernel."id"
          ORDER BY "sampled_at" DESC
          LIMIT 1
        ) AS capacity ON TRUE
        WHERE kernel."space_id" = ${input.spaceId}::uuid
        LIMIT 1
      `,
    );
    const row = rows[0];
    if (row === undefined) {
      return {
        capacity: { reason: "no-sample", status: "unavailable" },
        health: { reason: "no-sample", status: "unavailable" },
        organizationId: input.organizationId,
        spaceId: input.spaceId,
      };
    }
    const now = this.clock.now().getTime();
    return {
      capacity: capacityView(row, now),
      health: healthView(row, now),
      organizationId: input.organizationId,
      spaceId: input.spaceId,
    };
  }
}
