import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type {
  AccessOperation,
  AccessOperationResult,
  InitializeAccessOperation,
  SetKernelStateAccessOperation,
  SetSpaceMemberAccessOperation,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import type { Clock } from "../identity/clock.js";
import { IdentityService } from "../identity/identity.service.js";
import { SpaceAccessService } from "../spaces/space-access.service.js";

type Transaction = Prisma.TransactionClient;
type OperationOutcome = AccessOperationResult["outcome"];
type OperationBaseResult<Outcome extends OperationOutcome> = {
  operationId: string;
  outcome: Outcome;
};

@Injectable()
export class AccessOperationsService {
  readonly #logger = new Logger("AccessOperationsService");

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly identity: IdentityService,
    private readonly spaces: SpaceAccessService,
    private readonly clock: Clock,
  ) {}

  async execute(command: AccessOperation): Promise<AccessOperationResult> {
    const operationId = randomUUID();
    try {
      let result: AccessOperationResult;
      switch (command.operation) {
        case "initialize":
          result = await this.#initialize(operationId, command);
          break;
        case "create-user":
          result = await this.#createUser(operationId, command);
          break;
        case "create-space":
          result = await this.#createSpace(operationId, command);
          break;
        case "set-kernel-state":
          result = await this.#setKernelState(operationId, command);
          break;
        case "set-space-member":
          result = await this.#setSpaceMember(operationId, command);
          break;
        case "revoke-space-member":
          result = await this.#revokeSpaceMember(operationId, command);
          break;
        case "disable-organization":
          result = await this.#disableOrganization(operationId, command.organizationId);
          break;
        case "disable-space":
          result = await this.#disableSpace(operationId, command.spaceId);
          break;
        case "revoke-organization-member":
          result = await this.#revokeOrganizationMember(
            operationId,
            command.organizationId,
            command.userId,
          );
          break;
        case "disable-user":
          result = await this.#disableUser(operationId, command.userId);
          break;
        case "revoke-user-sessions":
          result = await this.#revokeUserSessions(operationId, command.userId);
          break;
      }
      this.#log(command, result);
      return result;
    } catch {
      const result = { operationId, outcome: "failed" } as const;
      this.#log(command, result);
      return result;
    }
  }

  async #initialize(
    operationId: string,
    command: InitializeAccessOperation,
  ): Promise<AccessOperationResult> {
    const passwordDigest = await this.identity.hashPassword(command.password);
    const now = this.clock.now();
    try {
      return await this.database.client.$transaction(async (transaction) => {
        await transaction.systemInstallation.create({
          data: { id: 1, initializedAt: now },
        });
        const user = await transaction.user.create({
          data: {
            loginIdentifier: command.loginIdentifier,
            passwordDigest,
            status: "active",
          },
          select: { id: true },
        });
        const organization = await transaction.organization.create({
          data: { name: command.organizationName, status: "active" },
          select: { id: true },
        });
        await transaction.organizationMembership.create({
          data: {
            organizationId: organization.id,
            role: "owner",
            status: "active",
            userId: user.id,
          },
        });
        const space = await transaction.space.create({
          data: {
            name: command.spaceName,
            organizationId: organization.id,
            status: "active",
          },
          select: { id: true },
        });
        await transaction.spaceMembership.create({
          data: {
            organizationId: organization.id,
            role: "admin",
            spaceId: space.id,
            status: "active",
            userId: user.id,
          },
        });
        await transaction.kernelInstance.create({
          data: {
            deploymentHandle: null,
            spaceId: space.id,
            status: "starting",
            version: null,
          },
        });
        return {
          operationId,
          organizationId: organization.id,
          outcome: "created",
          spaceId: space.id,
          userId: user.id,
        };
      });
    } catch (error) {
      if (this.#isUniqueConflict(error)) {
        const installation = await this.database.client.systemInstallation.findUnique({
          where: { id: 1 },
          select: { id: true },
        });
        return this.#result(
          operationId,
          installation === null ? "conflict" : "already-initialized",
        );
      }
      throw error;
    }
  }

  async #createUser(
    operationId: string,
    command: Extract<AccessOperation, { operation: "create-user" }>,
  ): Promise<AccessOperationResult> {
    const passwordDigest = await this.identity.hashPassword(command.password);
    try {
      return await this.database.client.$transaction(async (transaction) => {
        if (!(await this.#lockOrganization(transaction, command.organizationId))) {
          return this.#result(operationId, "not-found");
        }
        const organization = await transaction.organization.findUnique({
          where: { id: command.organizationId },
          select: { status: true },
        });
        if (organization?.status !== "active") {
          return this.#result(operationId, "conflict");
        }
        const userId = await this.identity.createUserInTransaction(transaction, {
          loginIdentifier: command.loginIdentifier,
          organizationId: command.organizationId,
          passwordDigest,
        });
        return { operationId, outcome: "created", userId };
      });
    } catch (error) {
      if (this.#isUniqueConflict(error)) {
        return this.#result(operationId, "conflict");
      }
      throw error;
    }
  }

  async #createSpace(
    operationId: string,
    command: Extract<AccessOperation, { operation: "create-space" }>,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockUser(transaction, command.adminUserId))) {
        return this.#result(operationId, "not-found");
      }
      if (!(await this.#lockOrganization(transaction, command.organizationId))) {
        return this.#result(operationId, "not-found");
      }
      if (
        !(await this.#lockOrganizationMembership(
          transaction,
          command.organizationId,
          command.adminUserId,
        ))
      ) {
        return this.#result(operationId, "not-found");
      }
      const spaceId = await this.spaces.createSpaceInTransaction(transaction, {
        adminUserId: command.adminUserId,
        name: command.name,
        organizationId: command.organizationId,
      });
      return typeof spaceId === "string"
        ? this.#result(operationId, spaceId)
        : { operationId, outcome: "created", spaceId: spaceId.spaceId };
    });
  }

  async #setKernelState(
    operationId: string,
    command: SetKernelStateAccessOperation,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockSpace(transaction, command.spaceId))) {
        return this.#result(operationId, "not-found");
      }
      const space = await transaction.space.findUnique({
        where: { id: command.spaceId },
        select: { status: true },
      });
      if (space?.status !== "active") {
        return this.#result(operationId, "conflict");
      }
      if (!(await this.#lockKernelInstance(transaction, command.spaceId))) {
        return this.#result(operationId, "not-found");
      }
      await transaction.kernelInstance.update({
        where: { spaceId: command.spaceId },
        data:
          command.kernelState === "starting"
            ? {
                deploymentHandle: null,
                status: "starting",
                version: null,
              }
            : {
                deploymentHandle: command.deploymentHandle,
                status: command.kernelState,
                version: command.version,
              },
      });
      return this.#result(operationId, "updated");
    });
  }

  async #setSpaceMember(
    operationId: string,
    command: SetSpaceMemberAccessOperation,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      const ownership = await transaction.space.findUnique({
        where: { id: command.spaceId },
        select: { organizationId: true },
      });
      if (ownership === null) {
        return this.#result(operationId, "not-found");
      }
      if (!(await this.#lockUser(transaction, command.userId))) {
        return this.#result(operationId, "not-found");
      }
      if (!(await this.#lockOrganization(transaction, ownership.organizationId))) {
        return this.#result(operationId, "not-found");
      }
      if (
        !(await this.#lockOrganizationMembership(
          transaction,
          ownership.organizationId,
          command.userId,
        ))
      ) {
        return this.#result(operationId, "not-found");
      }
      if (!(await this.#lockSpace(transaction, command.spaceId))) {
        return this.#result(operationId, "not-found");
      }
      const [user, organization, organizationMembership, space] =
        await Promise.all([
          transaction.user.findUnique({
            where: { id: command.userId },
            select: { status: true },
          }),
          transaction.organization.findUnique({
            where: { id: ownership.organizationId },
            select: { status: true },
          }),
          transaction.organizationMembership.findUnique({
            where: {
              organizationId_userId: {
                organizationId: ownership.organizationId,
                userId: command.userId,
              },
            },
            select: { status: true },
          }),
          transaction.space.findUnique({
            where: { id: command.spaceId },
            select: { organizationId: true, status: true },
          }),
        ]);
      if (
        user?.status !== "active" ||
        organization?.status !== "active" ||
        organizationMembership?.status !== "active" ||
        space?.status !== "active" ||
        space.organizationId !== ownership.organizationId
      ) {
        return this.#result(operationId, "conflict");
      }
      const existing = await this.#lockSpaceMembership(
        transaction,
        command.spaceId,
        command.userId,
      );
      if (existing) {
        await transaction.spaceMembership.update({
          where: {
            spaceId_userId: {
              spaceId: command.spaceId,
              userId: command.userId,
            },
          },
          data: { role: command.role, status: "active" },
        });
        return this.#result(operationId, "updated");
      }
      await transaction.spaceMembership.create({
        data: {
          organizationId: ownership.organizationId,
          role: command.role,
          spaceId: command.spaceId,
          status: "active",
          userId: command.userId,
        },
      });
      return this.#result(operationId, "created");
    });
  }

  async #revokeSpaceMember(
    operationId: string,
    command: Extract<AccessOperation, { operation: "revoke-space-member" }>,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      const ownership = await transaction.space.findUnique({
        where: { id: command.spaceId },
        select: { organizationId: true },
      });
      if (ownership === null || !(await this.#lockUser(transaction, command.userId))) {
        return this.#result(operationId, "not-found");
      }
      if (!(await this.#lockOrganization(transaction, ownership.organizationId))) {
        return this.#result(operationId, "not-found");
      }
      if (
        !(await this.#lockOrganizationMembership(
          transaction,
          ownership.organizationId,
          command.userId,
        )) ||
        !(await this.#lockSpace(transaction, command.spaceId))
      ) {
        return this.#result(operationId, "not-found");
      }
      await this.#lockSpaceMembership(
        transaction,
        command.spaceId,
        command.userId,
      );
      await transaction.spaceMembership.updateMany({
        where: { spaceId: command.spaceId, userId: command.userId },
        data: { status: "inactive" },
      });
      return this.#result(operationId, "revoked");
    });
  }

  async #disableOrganization(
    operationId: string,
    organizationId: string,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockOrganization(transaction, organizationId))) {
        return this.#result(operationId, "not-found");
      }
      await transaction.organization.update({
        where: { id: organizationId },
        data: { status: "disabled" },
      });
      return this.#result(operationId, "updated");
    });
  }

  async #disableSpace(
    operationId: string,
    spaceId: string,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockSpace(transaction, spaceId))) {
        return this.#result(operationId, "not-found");
      }
      await transaction.space.update({
        where: { id: spaceId },
        data: { status: "disabled" },
      });
      return this.#result(operationId, "updated");
    });
  }

  async #revokeOrganizationMember(
    operationId: string,
    organizationId: string,
    userId: string,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockUser(transaction, userId))) {
        return this.#result(operationId, "not-found");
      }
      if (!(await this.#lockOrganization(transaction, organizationId))) {
        return this.#result(operationId, "not-found");
      }
      if (
        !(await this.#lockOrganizationMembership(
          transaction,
          organizationId,
          userId,
        ))
      ) {
        return this.#result(operationId, "not-found");
      }
      const membership = await transaction.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true, status: true },
      });
      if (membership?.role === "owner" && membership.status === "active") {
        return this.#result(operationId, "conflict");
      }
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT space."id"
          FROM "spaces" AS space
          INNER JOIN "space_memberships" AS membership
            ON membership."space_id" = space."id"
          WHERE membership."organization_id" = ${organizationId}
            AND membership."user_id" = ${userId}
          ORDER BY space."id"
          FOR UPDATE OF space
        `,
      );
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "space_memberships"
          WHERE "organization_id" = ${organizationId}
            AND "user_id" = ${userId}
          ORDER BY "space_id", "id"
          FOR UPDATE
        `,
      );
      await transaction.organizationMembership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { status: "inactive" },
      });
      await transaction.spaceMembership.updateMany({
        where: { organizationId, userId },
        data: { status: "inactive" },
      });
      return this.#result(operationId, "revoked");
    });
  }

  async #disableUser(
    operationId: string,
    userId: string,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockUser(transaction, userId))) {
        return this.#result(operationId, "not-found");
      }
      const outcome = await this.identity.disableUserInTransaction(
        transaction,
        userId,
        this.clock.now(),
      );
      return this.#result(operationId, outcome);
    });
  }

  async #revokeUserSessions(
    operationId: string,
    userId: string,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockUser(transaction, userId))) {
        return this.#result(operationId, "not-found");
      }
      const outcome = await this.identity.revokeUserSessionsInTransaction(
        transaction,
        userId,
        this.clock.now(),
      );
      return this.#result(operationId, outcome);
    });
  }

  async #lockUser(transaction: Transaction, userId: string): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`,
    );
    return rows.length === 1;
  }

  async #lockOrganization(
    transaction: Transaction,
    organizationId: string,
  ): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`,
    );
    return rows.length === 1;
  }

  async #lockOrganizationMembership(
    transaction: Transaction,
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "organization_memberships" WHERE "organization_id" = ${organizationId} AND "user_id" = ${userId} FOR UPDATE`,
    );
    return rows.length === 1;
  }

  async #lockSpace(transaction: Transaction, spaceId: string): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "spaces" WHERE "id" = ${spaceId} FOR UPDATE`,
    );
    return rows.length === 1;
  }

  async #lockSpaceMembership(
    transaction: Transaction,
    spaceId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "space_memberships" WHERE "space_id" = ${spaceId} AND "user_id" = ${userId} FOR UPDATE`,
    );
    return rows.length === 1;
  }

  async #lockKernelInstance(
    transaction: Transaction,
    spaceId: string,
  ): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "kernel_instances" WHERE "space_id" = ${spaceId} FOR UPDATE`,
    );
    return rows.length === 1;
  }

  #isUniqueConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }

  #result<Outcome extends OperationOutcome>(
    operationId: string,
    outcome: Outcome,
  ): OperationBaseResult<Outcome> {
    return { operationId, outcome };
  }

  #log(command: AccessOperation, result: AccessOperationResult): void {
    const entry: Record<string, string> = {
      event: "access.operation",
      operation: command.operation,
      operationId: result.operationId,
      outcome: result.outcome,
    };
    if ("organizationId" in command) {
      entry.organizationId = command.organizationId;
    }
    if ("spaceId" in command) {
      entry.spaceId = command.spaceId;
    }
    if ("userId" in command) {
      entry.userId = command.userId;
    } else if ("adminUserId" in command) {
      entry.userId = command.adminUserId;
    }
    if ("organizationId" in result) {
      entry.organizationId = result.organizationId;
    }
    if ("spaceId" in result) {
      entry.spaceId = result.spaceId;
    }
    if ("userId" in result) {
      entry.userId = result.userId;
    }
    if (result.outcome === "failed") {
      this.#logger.error(entry);
      return;
    }
    if (
      result.outcome === "already-initialized" ||
      result.outcome === "conflict" ||
      result.outcome === "not-found"
    ) {
      this.#logger.warn(entry);
      return;
    }
    this.#logger.log(entry);
  }
}
