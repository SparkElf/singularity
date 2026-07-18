import { performance } from "node:perf_hooks";

import { Injectable, Logger } from "@nestjs/common";
import type {
  AuthorizedSpaceSummary,
  SpaceRole,
  SpaceRuntimeBootstrap,
} from "@singularity/contracts";
import { DatabaseRuntime, type Prisma } from "@singularity/database";

function normalizedSortValue(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const roleWeight: Record<SpaceRole, number> = {
  admin: 3,
  editor: 2,
  viewer: 1,
};

function effectiveRole(roles: readonly SpaceRole[]): SpaceRole | null {
  let result: SpaceRole | null = null;
  for (const role of roles) {
    if (result === null || roleWeight[role] > roleWeight[result]) {
      result = role;
    }
  }
  return result;
}

@Injectable()
export class SpaceAccessService {
  readonly #authorizationLogger = new Logger("AuthorizationService");
  readonly #runtimeLogger = new Logger("SpaceRuntimeService");

  constructor(private readonly database: DatabaseRuntime) {}

  async listAuthorizedSpaces(userId: string): Promise<AuthorizedSpaceSummary[]> {
    const spaces = await this.database.client.space.findMany({
      where: {
        status: "active",
        organization: {
          status: "active",
          memberships: {
            some: { status: "active", userId, user: { status: "active" } },
          },
        },
        OR: [
          { memberships: { some: { status: "active", userId } } },
          {
            groupGrants: {
              some: {
                group: {
                  status: "active",
                  memberships: { some: { userId } },
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        organizationId: true,
        organization: { select: { name: true } },
        memberships: {
          where: { status: "active", userId },
          select: { role: true },
        },
        groupGrants: {
          where: {
            group: {
              status: "active",
              memberships: { some: { userId } },
            },
          },
          select: { role: true },
        },
      },
    });
    return spaces
      .map((space) => {
        const role = effectiveRole([
          ...space.memberships.map((membership) => membership.role),
          ...space.groupGrants.map((grant) => grant.role),
        ]);
        return role === null
          ? null
          : {
              organizationId: space.organizationId,
              organizationName: space.organization.name,
              role,
              spaceId: space.id,
              spaceName: space.name,
            };
      })
      .filter((space): space is AuthorizedSpaceSummary => space !== null)
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
    const space = await this.database.client.space.findFirst({
      where: {
        id: spaceId,
        organizationId,
        status: "active",
        organization: {
          id: organizationId,
          status: "active",
          memberships: {
            some: {
              organizationId,
              status: "active",
              userId,
              user: { status: "active" },
            },
          },
        },
        OR: [
          { memberships: { some: { status: "active", userId } } },
          {
            groupGrants: {
              some: {
                group: {
                  status: "active",
                  memberships: { some: { organizationId, userId } },
                },
              },
            },
          },
        ],
      },
      select: {
        kernelInstance: { select: { status: true } },
        memberships: {
          where: { status: "active", userId },
          select: { role: true },
        },
        groupGrants: {
          where: {
            group: {
              status: "active",
              memberships: { some: { organizationId, userId } },
            },
          },
          select: { role: true },
        },
      },
    });
    const role =
      space === null
        ? null
        : effectiveRole([
            ...space.memberships.map((membership) => membership.role),
            ...space.groupGrants.map((grant) => grant.role),
          ]);
    if (space === null || role === null) {
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
    if (space.kernelInstance === null) {
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
      role,
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
      status: space.kernelInstance.status,
    });
    return {
      kernelState: space.kernelInstance.status,
      organizationId,
      role,
      spaceId,
    };
  }

  async getEffectiveRole(
    userId: string,
    organizationId: string,
    spaceId: string,
    includeArchived = false,
  ): Promise<SpaceRole | null> {
    const space = await this.database.client.space.findFirst({
      where: {
        id: spaceId,
        organizationId,
        status: includeArchived ? { in: ["active", "archived"] } : "active",
        organization: {
          status: "active",
          memberships: {
            some: { status: "active", userId, user: { status: "active" } },
          },
        },
      },
      select: {
        memberships: {
          where: { status: "active", userId },
          select: { role: true },
        },
        groupGrants: {
          where: {
            group: {
              status: "active",
              memberships: { some: { organizationId, userId } },
            },
          },
          select: { role: true },
        },
      },
    });
    return space === null
      ? null
      : effectiveRole([
          ...space.memberships.map((membership) => membership.role),
          ...space.groupGrants.map((grant) => grant.role),
        ]);
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
