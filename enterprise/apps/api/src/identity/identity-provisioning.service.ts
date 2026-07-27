import { randomBytes, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import { conflict } from "../problem.js";
import { CLOCK } from "../tokens.js";
import type { Clock } from "./clock.js";
import { PasswordHasher } from "./password-hasher.js";

export const INITIAL_ADMIN_LOGIN_IDENTIFIER = "admin";
export const INITIAL_ADMIN_ORGANIZATION_NAME = "奇点";
export const INITIAL_ADMIN_SPACE_NAME = "默认知识空间";

type Transaction = Prisma.TransactionClient;

export interface ProvisioningInput {
  readonly loginIdentifier: string;
  readonly organizationName: string;
  readonly passwordDigest: string;
  readonly requestId: string;
  readonly spaceName: string;
}

export interface RegisteredUserInput {
  readonly loginIdentifier: string;
  readonly passwordDigest: string;
}

export interface ProvisionedInstallation {
  readonly organizationId: string;
  readonly spaceId: string;
  readonly userId: string;
}

export interface InitialAdminBootstrapResult {
  readonly created: boolean;
  readonly loginIdentifier: typeof INITIAL_ADMIN_LOGIN_IDENTIFIER;
  readonly organizationId?: string;
  readonly password?: string;
  readonly spaceId?: string;
  readonly userId?: string;
}

@Injectable()
export class IdentityProvisioningService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly audit: AuditWriter,
    private readonly passwordHasher: PasswordHasher,
    @Inject(CLOCK)
    private readonly clock: Clock,
  ) {}

  /**
   * 在 API 首次部署时原子创建固定 admin；密码只在本次创建结果中返回，调用方负责一次性安全输出。
   * SystemInstallation 主键是并发启动的唯一 owner，已有安装不会重新生成或覆盖管理员密码。
   */
  async ensureInitialInstallation(): Promise<InitialAdminBootstrapResult> {
    const existing = await this.database.client.systemInstallation.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    if (existing !== null) {
      return {
        created: false,
        loginIdentifier: INITIAL_ADMIN_LOGIN_IDENTIFIER,
      };
    }
    const password = randomBytes(32).toString("base64url");
    const passwordDigest = await this.passwordHasher.hashPassword(password);
    try {
      const installation = await this.database.client.$transaction(
        async (transaction) => {
          await transaction.systemInstallation.create({
            data: { id: 1, initializedAt: this.clock.now() },
          });
          return this.createOwnerInstallationGraph(transaction, {
            loginIdentifier: INITIAL_ADMIN_LOGIN_IDENTIFIER,
            organizationName: INITIAL_ADMIN_ORGANIZATION_NAME,
            passwordDigest,
            requestId: randomUUID(),
            spaceName: INITIAL_ADMIN_SPACE_NAME,
          });
        },
      );
      return {
        created: true,
        loginIdentifier: INITIAL_ADMIN_LOGIN_IDENTIFIER,
        organizationId: installation.organizationId,
        password,
        spaceId: installation.spaceId,
        userId: installation.userId,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const installation = await this.database.client.systemInstallation.findUnique({
          where: { id: 1 },
          select: { id: true },
        });
        if (installation !== null) {
          return {
            created: false,
            loginIdentifier: INITIAL_ADMIN_LOGIN_IDENTIFIER,
          };
        }
      }
      throw error;
    }
  }

  /** 读取首次安装状态；注册始终开放，不从安装状态推断注册权限。 */
  async getSetupStatus(): Promise<{
    initialized: boolean;
  }> {
    const installation = await this.database.client.systemInstallation.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    return { initialized: installation !== null };
  }

  /** 在调用方事务内创建唯一首个管理员及其组织、空间和 Kernel 实例。 */
  async createInitialInstallationInTransaction(
    transaction: Transaction,
    input: ProvisioningInput,
  ): Promise<ProvisionedInstallation> {
    await transaction.systemInstallation.create({
      data: { id: 1, initializedAt: this.clock.now() },
    });
    return this.createOwnerInstallationGraph(transaction, input);
  }

  /** 在已初始化的系统内只创建本地用户，不写入任何组织或成员关系。 */
  async createRegisteredUserInTransaction(
    transaction: Transaction,
    input: RegisteredUserInput,
  ): Promise<string> {
    const installation = await transaction.$queryRaw<Array<{ id: number }>>(
      Prisma.sql`SELECT "id" FROM "system_installations" WHERE "id" = 1 FOR SHARE`,
    );
    if (installation.length !== 1) {
      throw conflict();
    }
    const user = await transaction.user.create({
      data: {
        loginIdentifier: input.loginIdentifier,
        passwordDigest: input.passwordDigest,
        status: "active",
      },
      select: { id: true },
    });
    return user.id;
  }

  /** 创建用户、owner 组织、首个空间及空间管理员，并在同一事务写入权限审计。 */
  private async createOwnerInstallationGraph(
    transaction: Transaction,
    input: ProvisioningInput,
  ): Promise<ProvisionedInstallation> {
    const user = await transaction.user.create({
      data: {
        loginIdentifier: input.loginIdentifier,
        passwordDigest: input.passwordDigest,
        status: "active",
      },
      select: { id: true },
    });
    const organization = await transaction.organization.create({
      data: { name: input.organizationName, status: "active" },
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
        name: input.spaceName,
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
    const now = this.clock.now();
    await this.audit.appendPermissionChange(transaction, {
      actorUserId: null,
      occurredAt: now,
      organizationId: organization.id,
      requestId: input.requestId,
      spaceId: null,
      targetId: user.id,
      targetType: "membership",
    });
    await this.audit.appendPermissionChange(transaction, {
      actorUserId: null,
      occurredAt: now,
      organizationId: organization.id,
      requestId: input.requestId,
      spaceId: space.id,
      targetId: user.id,
      targetType: "membership",
    });
    return {
      organizationId: organization.id,
      spaceId: space.id,
      userId: user.id,
    };
  }
}
