import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import type {
  AccessOperation,
  AccessOperationResult,
  AuditTargetType,
  InitializeAccessOperation,
  SetKernelStateAccessOperation,
  SetSpaceMemberAccessOperation,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";
import {
  KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
  type KernelDeploymentChangedEvent,
} from "@singularity/kernel-client";

import { AuditWriter } from "../audit/audit-writer.service.js";
import type { Clock } from "../identity/clock.js";
import { IdentityService } from "../identity/identity.service.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { SpaceAccessService } from "../spaces/space-access.service.js";
import { CLOCK } from "../tokens.js";
import { HandlesAccessOperation } from "./access-operation-handler.decorator.js";
import {
  AccessOperationDiscovery,
  type AccessOperationHandlerRegistry,
} from "./access-operation-discovery.js";

type Transaction = Prisma.TransactionClient;
type OperationOutcome = AccessOperationResult["outcome"];
type OperationBaseResult<Outcome extends OperationOutcome> = {
  operationId: string;
  outcome: Outcome;
};
type KernelInstanceState = SetKernelStateAccessOperation["kernelState"];

interface LockedKernelInstance {
  deploymentHandle: string | null;
  id: string;
  status: KernelInstanceState;
}

interface KernelStateTransition {
  fromState: KernelInstanceState;
  kernelInstanceId: string;
  toState: KernelInstanceState;
}

async function publishKernelDeploymentChange(
  transaction: Prisma.TransactionClient,
  event: KernelDeploymentChangedEvent,
): Promise<void> {
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_notify(${KERNEL_DEPLOYMENT_CHANGED_CHANNEL}, ${JSON.stringify(event)})`,
  );
}

@Injectable()
export class AccessOperationsService implements OnModuleInit {
  readonly #logger = new Logger("AccessOperationsService");
  #handlers!: AccessOperationHandlerRegistry;

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly identity: IdentityService,
    private readonly spaces: SpaceAccessService,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly audit: AuditWriter,
    private readonly handlerDiscovery: AccessOperationDiscovery,
  ) {}

  onModuleInit(): void {
    this.#handlers = this.handlerDiscovery.handlers();
  }

  async execute(command: AccessOperation): Promise<AccessOperationResult> {
    const operationId = randomUUID();
    try {
      const handler = this.#handlers.get(command.operation)!;
      const result = await handler.execute(operationId, command);
      this.#log(command, result);
      return result;
    } catch {
      const result = { operationId, outcome: "failed" } as const;
      this.#log(command, result);
      return result;
    }
  }

  @HandlesAccessOperation("initialize")
  private async initialize(
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
        await this.#appendPermissionChange(transaction, operationId, {
          occurredAt: now,
          organizationId: organization.id,
          spaceId: null,
          targetId: user.id,
          targetType: "membership",
        });
        await this.#appendPermissionChange(transaction, operationId, {
          occurredAt: now,
          organizationId: organization.id,
          spaceId: space.id,
          targetId: user.id,
          targetType: "membership",
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

  @HandlesAccessOperation("create-user")
  private async createUser(
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
        await this.#appendPermissionChange(transaction, operationId, {
          organizationId: command.organizationId,
          spaceId: null,
          targetId: userId,
          targetType: "membership",
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

  @HandlesAccessOperation("create-space")
  private async createSpace(
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
      if (typeof spaceId === "string") {
        return this.#result(operationId, spaceId);
      }
      await this.#appendPermissionChange(transaction, operationId, {
        organizationId: command.organizationId,
        spaceId: spaceId.spaceId,
        targetId: command.adminUserId,
        targetType: "membership",
      });
      return { operationId, outcome: "created", spaceId: spaceId.spaceId };
    });
  }

  @HandlesAccessOperation("set-kernel-state")
  private async setKernelState(
    operationId: string,
    command: SetKernelStateAccessOperation,
  ): Promise<AccessOperationResult> {
    const startedAt = performance.now();
    const committed = await this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockSpace(transaction, command.spaceId))) {
        return {
          result: this.#result(operationId, "not-found"),
          transition: null,
        };
      }
      const space = await transaction.space.findUnique({
        where: { id: command.spaceId },
        select: { organizationId: true, status: true },
      });
      if (space?.status !== "active") {
        return {
          result: this.#result(operationId, "conflict"),
          transition: null,
        };
      }
      const kernelInstance = await this.#lockKernelInstance(
        transaction,
        command.spaceId,
      );
      if (kernelInstance === null) {
        return {
          result: this.#result(operationId, "not-found"),
          transition: null,
        };
      }
      const endpointRows = await transaction.$queryRaw<
        Array<{ deploymentHandle: string; kernelInstanceId: string; spaceId: string }>
      >(
        Prisma.sql`
          SELECT
            kernel."deployment_handle" AS "deploymentHandle",
            endpoint."kernel_instance_id" AS "kernelInstanceId",
            endpoint."space_id" AS "spaceId"
          FROM "kernel_runtime_endpoints" AS endpoint
          INNER JOIN "kernel_instances" AS kernel
            ON kernel."id" = endpoint."kernel_instance_id"
            AND kernel."space_id" = endpoint."space_id"
          WHERE endpoint."kernel_instance_id" = ${kernelInstance.id}::uuid
            AND kernel."deployment_handle" IS NOT NULL
          LIMIT 1
        `,
      );
      await transaction.$executeRaw(
        Prisma.sql`
          DELETE FROM "kernel_runtime_endpoints"
          WHERE "kernel_instance_id" = ${kernelInstance.id}::uuid
        `,
      );
      await transaction.kernelInstance.update({
        where: { id: kernelInstance.id },
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
      const endpoint = endpointRows[0];
      const previousDeploymentHandle = kernelInstance.deploymentHandle;
      const leavesReadyState =
        kernelInstance.status === "ready" &&
        (command.kernelState !== "ready" ||
          command.deploymentHandle !== previousDeploymentHandle);
      const deploymentHandleToRemove =
        endpoint?.deploymentHandle ??
        (leavesReadyState ? previousDeploymentHandle : null);
      if (
        deploymentHandleToRemove !== null &&
        deploymentHandleToRemove !== undefined
      ) {
        await publishKernelDeploymentChange(transaction, {
          deploymentHandle: deploymentHandleToRemove,
          kernelInstanceId: kernelInstance.id,
          kind: "remove",
          requestId: operationId,
          spaceId: endpoint?.spaceId ?? command.spaceId,
        });
      }
      await this.#appendPermissionChange(transaction, operationId, {
        organizationId: space.organizationId,
        spaceId: command.spaceId,
        targetId: command.spaceId,
        targetType: "space",
      });
      const transition: KernelStateTransition | null =
        kernelInstance.status === command.kernelState
          ? null
          : {
              fromState: kernelInstance.status,
              kernelInstanceId: kernelInstance.id,
              toState: command.kernelState,
            };
      return {
        result: this.#result(operationId, "updated"),
        transition,
      };
    });
    if (committed.transition !== null) {
      this.#logger.log({
        elapsedMs: performance.now() - startedAt,
        event: "kernel.lifecycle",
        fromState: committed.transition.fromState,
        kernelInstanceId: committed.transition.kernelInstanceId,
        reason: command.operation,
        requestId: operationId,
        spaceId: command.spaceId,
        toState: committed.transition.toState,
      });
    }
    return committed.result;
  }

  @HandlesAccessOperation("set-space-member")
  private async setSpaceMember(
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
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId: operationId,
          selectors: [
            { kind: "space", value: command.spaceId },
            { kind: "user", value: command.userId },
          ],
        });
        await this.#appendPermissionChange(transaction, operationId, {
          organizationId: ownership.organizationId,
          spaceId: command.spaceId,
          targetId: command.userId,
          targetType: "membership",
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
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId: operationId,
        selectors: [
          { kind: "space", value: command.spaceId },
          { kind: "user", value: command.userId },
        ],
      });
      await this.#appendPermissionChange(transaction, operationId, {
        organizationId: ownership.organizationId,
        spaceId: command.spaceId,
        targetId: command.userId,
        targetType: "membership",
      });
      return this.#result(operationId, "created");
    });
  }

  @HandlesAccessOperation("revoke-space-member")
  private async revokeSpaceMember(
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
      const revoked = await transaction.spaceMembership.updateMany({
        where: { spaceId: command.spaceId, userId: command.userId },
        data: { status: "inactive" },
      });
      if (revoked.count > 0) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId: operationId,
          selectors: [
            { kind: "space", value: command.spaceId },
            { kind: "user", value: command.userId },
          ],
        });
        await this.#appendPermissionChange(transaction, operationId, {
          organizationId: ownership.organizationId,
          spaceId: command.spaceId,
          targetId: command.userId,
          targetType: "membership",
        });
      }
      return this.#result(operationId, "revoked");
    });
  }

  @HandlesAccessOperation("disable-organization")
  private async disableOrganization(
    operationId: string,
    command: Extract<
      AccessOperation,
      { operation: "disable-organization" }
    >,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockOrganization(transaction, command.organizationId))) {
        return this.#result(operationId, "not-found");
      }
      await transaction.organization.update({
        where: { id: command.organizationId },
        data: { status: "disabled" },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId: operationId,
        selectors: [{ kind: "organization", value: command.organizationId }],
      });
      await this.#appendPermissionChange(transaction, operationId, {
        organizationId: command.organizationId,
        spaceId: null,
        targetId: command.organizationId,
        targetType: "organization",
      });
      return this.#result(operationId, "updated");
    });
  }

  @HandlesAccessOperation("disable-space")
  private async disableSpace(
    operationId: string,
    command: Extract<AccessOperation, { operation: "disable-space" }>,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockSpace(transaction, command.spaceId))) {
        return this.#result(operationId, "not-found");
      }
      const space = await transaction.space.findUnique({
        where: { id: command.spaceId },
        select: { organizationId: true },
      });
      if (space === null) {
        return this.#result(operationId, "not-found");
      }
      await transaction.space.update({
        where: { id: command.spaceId },
        data: { status: "disabled" },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId: operationId,
        selectors: [{ kind: "space", value: command.spaceId }],
      });
      await this.#appendPermissionChange(transaction, operationId, {
        organizationId: space.organizationId,
        spaceId: command.spaceId,
        targetId: command.spaceId,
        targetType: "space",
      });
      return this.#result(operationId, "updated");
    });
  }

  @HandlesAccessOperation("revoke-organization-member")
  private async revokeOrganizationMember(
    operationId: string,
    command: Extract<
      AccessOperation,
      { operation: "revoke-organization-member" }
    >,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockUser(transaction, command.userId))) {
        return this.#result(operationId, "not-found");
      }
      if (!(await this.#lockOrganization(transaction, command.organizationId))) {
        return this.#result(operationId, "not-found");
      }
      if (
        !(await this.#lockOrganizationMembership(
          transaction,
          command.organizationId,
          command.userId,
        ))
      ) {
        return this.#result(operationId, "not-found");
      }
      const membership = await transaction.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: command.organizationId,
            userId: command.userId,
          },
        },
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
          WHERE membership."organization_id" = ${command.organizationId}
            AND membership."user_id" = ${command.userId}
          ORDER BY space."id"
          FOR UPDATE OF space
        `,
      );
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "space_memberships"
          WHERE "organization_id" = ${command.organizationId}
            AND "user_id" = ${command.userId}
          ORDER BY "space_id", "id"
          FOR UPDATE
        `,
      );
      await transaction.organizationMembership.update({
        where: {
          organizationId_userId: {
            organizationId: command.organizationId,
            userId: command.userId,
          },
        },
        data: { status: "inactive" },
      });
      await transaction.spaceMembership.updateMany({
        where: {
          organizationId: command.organizationId,
          userId: command.userId,
        },
        data: { status: "inactive" },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId: operationId,
        selectors: [
          { kind: "organization", value: command.organizationId },
          { kind: "user", value: command.userId },
        ],
      });
      await this.#appendPermissionChange(transaction, operationId, {
        organizationId: command.organizationId,
        spaceId: null,
        targetId: command.userId,
        targetType: "membership",
      });
      return this.#result(operationId, "revoked");
    });
  }

  @HandlesAccessOperation("disable-user")
  private async disableUser(
    operationId: string,
    command: Extract<AccessOperation, { operation: "disable-user" }>,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockUser(transaction, command.userId))) {
        return this.#result(operationId, "not-found");
      }
      const organizationIds = await this.#activeOrganizationIdsForUser(
        transaction,
        command.userId,
      );
      const now = this.clock.now();
      const outcome = await this.identity.disableUserInTransaction(
        transaction,
        command.userId,
        now,
        operationId,
      );
      if (outcome === "updated") {
        for (const organizationId of organizationIds) {
          await this.#appendPermissionChange(transaction, operationId, {
            occurredAt: now,
            organizationId,
            spaceId: null,
            targetId: command.userId,
            targetType: "user",
          });
        }
      }
      return this.#result(operationId, outcome);
    });
  }

  @HandlesAccessOperation("revoke-user-sessions")
  private async revokeUserSessions(
    operationId: string,
    command: Extract<AccessOperation, { operation: "revoke-user-sessions" }>,
  ): Promise<AccessOperationResult> {
    return this.database.client.$transaction(async (transaction) => {
      if (!(await this.#lockUser(transaction, command.userId))) {
        return this.#result(operationId, "not-found");
      }
      const organizationIds = await this.#activeOrganizationIdsForUser(
        transaction,
        command.userId,
      );
      const now = this.clock.now();
      const outcome = await this.identity.revokeUserSessionsInTransaction(
        transaction,
        command.userId,
        now,
        operationId,
      );
      if (outcome === "revoked") {
        for (const organizationId of organizationIds) {
          await this.#appendPermissionChange(transaction, operationId, {
            occurredAt: now,
            organizationId,
            spaceId: null,
            targetId: command.userId,
            targetType: "session",
          });
        }
      }
      return this.#result(operationId, outcome);
    });
  }

  async #activeOrganizationIdsForUser(
    transaction: Transaction,
    userId: string,
  ): Promise<readonly string[]> {
    const memberships = await transaction.organizationMembership.findMany({
      where: {
        status: "active",
        userId,
        organization: { status: "active" },
      },
      orderBy: { organizationId: "asc" },
      select: { organizationId: true },
    });
    return memberships.map((membership) => membership.organizationId);
  }

  async #appendPermissionChange(
    transaction: Transaction,
    operationId: string,
    input: {
      readonly occurredAt?: Date;
      readonly organizationId: string;
      readonly spaceId: string | null;
      readonly targetId: string;
      readonly targetType: AuditTargetType;
    },
  ): Promise<void> {
    await this.audit.appendPermissionChange(transaction, {
      actorUserId: null,
      occurredAt: input.occurredAt ?? this.clock.now(),
      organizationId: input.organizationId,
      requestId: operationId,
      spaceId: input.spaceId,
      targetId: input.targetId,
      targetType: input.targetType,
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
  ): Promise<LockedKernelInstance | null> {
    const rows = await transaction.$queryRaw<LockedKernelInstance[]>(
      Prisma.sql`SELECT "deployment_handle" AS "deploymentHandle", "id", "status" FROM "kernel_instances" WHERE "space_id" = ${spaceId} FOR UPDATE`,
    );
    return rows[0] ?? null;
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
