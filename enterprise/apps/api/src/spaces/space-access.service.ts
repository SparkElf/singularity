import { performance } from "node:perf_hooks";

import { Injectable, Logger } from "@nestjs/common";
import type {
  AuthorizedSpaceSummary,
  SpaceRuntimeBootstrap,
} from "@singularity/contracts";
import { DatabaseRuntime, type Prisma } from "@singularity/database";

function normalizedSortValue(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

@Injectable()
export class SpaceAccessService {
  readonly #authorizationLogger = new Logger("AuthorizationService");
  readonly #runtimeLogger = new Logger("SpaceRuntimeService");

  constructor(private readonly database: DatabaseRuntime) {}

  async listAuthorizedSpaces(userId: string): Promise<AuthorizedSpaceSummary[]> {
    const memberships = await this.database.client.spaceMembership.findMany({
      where: {
        status: "active",
        userId,
        organizationMembership: {
          status: "active",
          user: { status: "active" },
          organization: { status: "active" },
        },
        space: {
          status: "active",
          organization: { status: "active" },
        },
      },
      select: {
        organizationId: true,
        role: true,
        space: {
          select: {
            id: true,
            name: true,
            organization: { select: { name: true } },
          },
        },
      },
    });
    return memberships
      .map((membership) => ({
        organizationId: membership.organizationId,
        organizationName: membership.space.organization.name,
        role: membership.role,
        spaceId: membership.space.id,
        spaceName: membership.space.name,
      }))
      .sort((left, right) => {
        const organizationComparison = compareText(
          normalizedSortValue(left.organizationName),
          normalizedSortValue(right.organizationName),
        );
        if (organizationComparison !== 0) {
          return organizationComparison;
        }
        const spaceComparison = compareText(
          normalizedSortValue(left.spaceName),
          normalizedSortValue(right.spaceName),
        );
        return spaceComparison !== 0
          ? spaceComparison
          : compareText(left.spaceId, right.spaceId);
      });
  }

  async getRuntime(
    userId: string,
    organizationId: string,
    spaceId: string,
    requestId: string,
  ): Promise<SpaceRuntimeBootstrap | null | "kernel-missing"> {
    const startedAt = performance.now();
    const membership = await this.database.client.spaceMembership.findFirst({
      where: {
        organizationId,
        spaceId,
        status: "active",
        userId,
        organizationMembership: {
          organizationId,
          status: "active",
          user: { status: "active" },
          organization: { id: organizationId, status: "active" },
        },
        space: {
          id: spaceId,
          organizationId,
          status: "active",
          organization: { id: organizationId, status: "active" },
        },
      },
      select: {
        role: true,
        space: {
          select: {
            kernelInstance: { select: { status: true } },
          },
        },
      },
    });
    if (membership === null) {
      this.#authorizationLogger.warn({
        action: "read-runtime",
        event: "authorization.decision",
        organizationId,
        outcome: "denied",
        requestId,
        spaceId,
        userId,
      });
      this.#runtimeLogger.warn({
        durationMilliseconds: performance.now() - startedAt,
        event: "space.runtime",
        organizationId,
        outcome: "not-found",
        requestId,
        spaceId,
      });
      return null;
    }
    if (membership.space.kernelInstance === null) {
      this.#runtimeLogger.warn({
        durationMilliseconds: performance.now() - startedAt,
        event: "space.runtime",
        organizationId,
        outcome: "service-unavailable",
        requestId,
        spaceId,
      });
      return "kernel-missing";
    }
    this.#authorizationLogger.debug({
      action: "read-runtime",
      event: "authorization.decision",
      organizationId,
      outcome: "allowed",
      requestId,
      role: membership.role,
      spaceId,
      userId,
    });
    this.#runtimeLogger.log({
      durationMilliseconds: performance.now() - startedAt,
      event: "space.runtime",
      organizationId,
      outcome: "resolved",
      requestId,
      spaceId,
      status: membership.space.kernelInstance.status,
    });
    return {
      kernelState: membership.space.kernelInstance.status,
      organizationId,
      role: membership.role,
      spaceId,
    };
  }

  async createSpaceInTransaction(
    transaction: Prisma.TransactionClient,
    input: { adminUserId: string; name: string; organizationId: string },
  ): Promise<{ spaceId: string } | "not-found" | "conflict"> {
    const organization = await transaction.organization.findUnique({
      where: { id: input.organizationId },
      select: { status: true },
    });
    const membership = await transaction.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: input.organizationId,
          userId: input.adminUserId,
        },
      },
      select: { status: true },
    });
    const user = await transaction.user.findUnique({
      where: { id: input.adminUserId },
      select: { status: true },
    });
    if (organization === null || membership === null || user === null) {
      return "not-found";
    }
    if (
      organization.status !== "active" ||
      membership.status !== "active" ||
      user.status !== "active"
    ) {
      return "conflict";
    }

    const space = await transaction.space.create({
      data: {
        name: input.name,
        organizationId: input.organizationId,
        status: "active",
        kernelInstance: {
          create: {
            deploymentHandle: null,
            status: "starting",
            version: null,
          },
        },
      },
      select: { id: true },
    });
    await transaction.spaceMembership.create({
      data: {
        organizationId: input.organizationId,
        role: "admin",
        spaceId: space.id,
        status: "active",
        userId: input.adminUserId,
      },
    });
    return { spaceId: space.id };
  }
}
