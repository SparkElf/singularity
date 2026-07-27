import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";
import { type PasswordResetConfirmRequest } from "@singularity/contracts";

import { serviceUnavailable, validationFailed } from "../problem.js";
import type { ApiConfiguration } from "../configuration.js";
import { API_CONFIGURATION, CLOCK, PASSWORD_RESET_MAILER } from "../tokens.js";
import type { Clock } from "./clock.js";
import { IdentityService } from "./identity.service.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";
import { PasswordHasher } from "./password-hasher.js";
import type { PasswordResetMailer } from "./password-reset-mailer.js";

export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_TOKEN_MILLISECONDS = 30 * 60 * 1_000;

const PASSWORD_RESET_TOKEN_DOMAIN = Buffer.from(
  "singularity.password-reset.v1",
  "utf8",
);
const DIGEST_SEPARATOR = Buffer.from([0]);

interface PreparedPasswordResetToken {
  readonly tokenValue: string;
  readonly tokenDigest: string;
  readonly expiresAt: Date;
}

/** 使用独立域常量生成令牌摘要，数据库永远不保存可重放的令牌明文。 */
function passwordResetTokenDigest(tokenValue: string): string {
  return createHash("sha256")
    .update(PASSWORD_RESET_TOKEN_DOMAIN)
    .update(DIGEST_SEPARATOR)
    .update(Buffer.from(tokenValue, "base64url"))
    .digest("hex");
}

/** 生成 32 字节随机令牌并绑定固定的 30 分钟过期时间。 */
function createPasswordResetToken(now: Date): PreparedPasswordResetToken {
  const tokenValue = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString("base64url");
  return {
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TOKEN_MILLISECONDS),
    tokenDigest: passwordResetTokenDigest(tokenValue),
    tokenValue,
  };
}

@Injectable()
export class PasswordResetService {
  readonly #logger = new Logger("PasswordResetService");

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly passwordHasher: PasswordHasher,
    private readonly identity: IdentityService,
    private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(CLOCK)
    private readonly clock: Clock,
    @Inject(PASSWORD_RESET_MAILER)
    private readonly mailer: PasswordResetMailer,
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
  ) {}

  /** 先确认邮件通道可用，再按邮箱创建短期令牌并投递恢复链接，始终不暴露账号是否存在。 */
  async request(input: {
    email: string;
    requestId: string;
    sourceAddress: string;
  }): Promise<void> {
    if (!this.mailer.configured) {
      throw serviceUnavailable();
    }
    await this.loginRateLimiter.consume(
      input.sourceAddress,
      input.email,
      input.requestId,
    );

    const user = await this.database.client.user.findUnique({
      where: { loginIdentifier: input.email },
      select: { id: true, status: true },
    });
    if (user === null || user.status !== "active") {
      return;
    }

    const prepared = await this.database.client.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${user.id} FOR UPDATE`,
      );
      if (locked.length !== 1) {
        return undefined;
      }
      const now = this.clock.now();
      const token = createPasswordResetToken(now);
      await transaction.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      await transaction.passwordResetToken.create({
        data: {
          expiresAt: token.expiresAt,
          tokenDigest: token.tokenDigest,
          userId: user.id,
        },
      });
      return token;
    });
    if (prepared === undefined) {
      return;
    }

    const resetUrl = new URL("/reset-password", this.configuration.publicOrigin);
    resetUrl.searchParams.set("token", prepared.tokenValue);
    try {
      await this.mailer.send({
        recipient: input.email,
        resetUrl: resetUrl.toString(),
      });
    } catch (error) {
      // 投递阶段统一返回 accepted，避免 SMTP 瞬时故障变成账号枚举信号；日志保留原始异常堆栈但不写入 token。
      this.#logger.error({
        error,
        event: "auth.password-reset.mail-failed",
        requestId: input.requestId,
        userId: user.id,
      });
    }
  }

  /** 在单事务内消费令牌、更新密码并撤销该用户全部旧会话，保证重放最多一次成功。 */
  async confirm(
    input: PasswordResetConfirmRequest & {
      requestId: string;
      sourceAddress: string;
    },
  ): Promise<void> {
    await this.loginRateLimiter.consume(
      input.sourceAddress,
      input.token,
      input.requestId,
    );
    const passwordDigest = await this.passwordHasher.hashPassword(input.password);
    const tokenDigest = passwordResetTokenDigest(input.token);
    const now = this.clock.now();

    await this.database.client.$transaction(async (transaction) => {
      const tokenRows = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "password_reset_tokens" WHERE "token_digest" = ${tokenDigest} FOR UPDATE`,
      );
      if (tokenRows.length !== 1) {
        throw validationFailed();
      }
      const token = await transaction.passwordResetToken.findUnique({
        where: { tokenDigest },
        select: { userId: true, expiresAt: true, usedAt: true },
      });
      if (
        token === null ||
        token.usedAt !== null ||
        now >= token.expiresAt
      ) {
        throw validationFailed();
      }

      const users = await transaction.$queryRaw<Array<{ id: string; status: string }>>(
        Prisma.sql`SELECT "id", "status"::text AS "status" FROM "users" WHERE "id" = ${token.userId} FOR UPDATE`,
      );
      if (users[0]?.status !== "active") {
        throw validationFailed();
      }

      const consumed = await transaction.passwordResetToken.updateMany({
        where: {
          tokenDigest,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw validationFailed();
      }
      await transaction.user.update({
        where: { id: token.userId },
        data: { passwordDigest },
      });
      await this.identity.revokeUserSessionsInTransaction(
        transaction,
        token.userId,
        now,
        input.requestId,
      );
    });

    this.#logger.log({
      event: "auth.password-reset.completed",
      requestId: input.requestId,
    });
  }
}
