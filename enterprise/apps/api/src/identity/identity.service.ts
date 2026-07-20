import { Inject, Injectable, Logger } from "@nestjs/common";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { forbidden, unauthenticated } from "../problem.js";
import type { Clock } from "./clock.js";
import { CLOCK } from "../tokens.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";
import { KdfAdmissionError, PasswordHasher } from "./password-hasher.js";
import {
  createSessionToken,
  isMatchingOpaqueToken,
  SESSION_ABSOLUTE_MILLISECONDS,
  SESSION_IDLE_MILLISECONDS,
  sessionTokenFromValue,
} from "./session-crypto.js";

export interface AuthenticatedSession {
  authSessionId: string;
  csrfToken: string;
  userId: string;
}

export interface LoginResult extends AuthenticatedSession {
  tokenValue: string;
}

interface RenewedSessionRow {
  authSessionId: string;
  expiresAt: Date;
  userId: string;
}

interface LockedSessionUserRow {
  status: "active" | "disabled";
  userId: string;
}

interface PreparedSessionIssue {
  readonly currentOwner: { readonly id: string; readonly userId: string } | null;
  readonly currentSession: ReturnType<typeof sessionTokenFromValue>;
  readonly newSession: ReturnType<typeof createSessionToken>;
}

interface IssuedSession {
  readonly created: { readonly id: string; readonly userId: string };
  readonly rotated: boolean;
}

export type IdentityTransactionResult =
  | "conflict"
  | "not-found"
  | "revoked"
  | "unchanged"
  | "updated";

@Injectable()
export class IdentityService {
  readonly #logger = new Logger("IdentityService");

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly passwordHasher: PasswordHasher,
    private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly accessChanges: AccessChangedPublisher,
    private readonly audit: AuditWriter,
  ) {}

  hashPassword(password: string): Promise<string> {
    return this.passwordHasher.hashPassword(password);
  }

  /** 校验本地凭据并轮换会话 token，登录失败只返回统一错误且保留完整审计上下文。 */
  async login(input: {
    currentTokenValue: string | undefined;
    loginIdentifier: string;
    password: string;
    requestId: string;
    sourceAddress: string;
  }): Promise<LoginResult> {
    await this.loginRateLimiter.consume(
      input.sourceAddress,
      input.loginIdentifier,
      input.requestId,
    );
    const database = this.database.client;
    const candidate = await database.user.findUnique({
      where: { loginIdentifier: input.loginIdentifier },
      select: { id: true, passwordDigest: true, status: true },
    });

    let passwordMatches = false;
    try {
      if (candidate === null || candidate.passwordDigest === null) {
        await this.passwordHasher.verifyDummy(input.password);
      } else {
        passwordMatches = await this.passwordHasher.verifyPassword(
          candidate.passwordDigest,
          input.password,
        );
      }
    } catch (error) {
      if (error instanceof KdfAdmissionError) {
        this.#logger.warn({
          event: "auth.rate-limit",
          keyTypes: ["kdf"],
          outcome: "rejected",
          requestId: input.requestId,
          retryAfter: error.retryAfter,
        });
      }
      throw error;
    }
    if (
      candidate === null ||
      !passwordMatches ||
      candidate.status !== "active"
    ) {
      this.#logger.warn({
        event: "auth.session",
        outcome: "rejected",
        requestId: input.requestId,
      });
      throw unauthenticated();
    }

    return this.issueSessionForUser({
      currentTokenValue: input.currentTokenValue,
      requestId: input.requestId,
      userId: candidate.id,
    });
  }

  /** 为已确认用户签发新会话，并在同一事务中撤销需要替换的旧会话。 */
  async issueSessionForUser(input: {
    currentTokenValue: string | undefined;
    requestId: string;
    userId: string;
  }): Promise<LoginResult> {
    const database = this.database.client;
    const prepared = await this.#prepareSessionIssue(input.currentTokenValue);

    const issued = await database.$transaction(async (transaction) => {
      const userIds = [...new Set([input.userId, prepared.currentOwner?.userId])]
        .filter((value): value is string => value !== undefined)
        .sort();
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" IN (${Prisma.join(
          userIds,
        )}) ORDER BY "id" FOR UPDATE`,
      );
      return this.#issuePreparedSession(
        transaction,
        prepared,
        input.userId,
        input.requestId,
      );
    });

    return this.#completeSessionIssue(prepared, issued, input.requestId);
  }

  /** 在创建用户事务提交后签发首个会话，保证用户与 token 不会跨事务半完成。 */
  async issueSessionForCreatedUser(input: {
    createUser: (transaction: Prisma.TransactionClient) => Promise<string>;
    currentTokenValue: string | undefined;
    requestId: string;
  }): Promise<LoginResult> {
    const prepared = await this.#prepareSessionIssue(input.currentTokenValue);
    const issued = await this.database.client.$transaction(async (transaction) => {
      if (prepared.currentOwner !== null) {
        await transaction.$queryRaw(
          Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${prepared.currentOwner.userId} FOR UPDATE`,
        );
      }
      const userId = await input.createUser(transaction);
      return this.#issuePreparedSession(
        transaction,
        prepared,
        userId,
        input.requestId,
      );
    });

    return this.#completeSessionIssue(prepared, issued, input.requestId);
  }

  /** 读取当前会话代次并准备 token 哈希，后续写入必须携带该代次条件。 */
  async #prepareSessionIssue(
    currentTokenValue: string | undefined,
  ): Promise<PreparedSessionIssue> {
    const currentSession =
      currentTokenValue === undefined
        ? undefined
        : sessionTokenFromValue(currentTokenValue);
    const currentOwner =
      currentSession === undefined
        ? null
        : await this.database.client.authSession.findUnique({
            where: { tokenDigest: currentSession.tokenDigest },
            select: { id: true, userId: true },
          });
    return { currentOwner, currentSession, newSession: createSessionToken() };
  }

  /** 在事务内持久化准备好的会话，使用发起时的 scope 防止迟到 logout 清理新会话。 */
  async #issuePreparedSession(
    transaction: Prisma.TransactionClient,
    prepared: PreparedSessionIssue,
    userId: string,
    requestId: string,
  ): Promise<IssuedSession> {
    const lockedUser = await transaction.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (lockedUser?.status !== "active") {
      this.#logUnauthenticated(requestId);
      throw unauthenticated();
    }
    const now = this.clock.now();
    const absoluteExpiresAt = new Date(
      now.getTime() + SESSION_ABSOLUTE_MILLISECONDS,
    );
    const idleExpiresAt = new Date(now.getTime() + SESSION_IDLE_MILLISECONDS);

    let rotated = false;
    if (prepared.currentSession !== undefined && prepared.currentOwner !== null) {
      const revoked = await transaction.authSession.updateMany({
        where: {
          tokenDigest: prepared.currentSession.tokenDigest,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      rotated = revoked.count > 0;
      if (rotated) {
        await this.accessChanges.publish(transaction, {
          kind: "close",
          reason: "unauthenticated",
          requestId,
          selectors: [
            { kind: "auth-session", value: prepared.currentOwner.id },
          ],
        });
      }
    }

    const created = await transaction.authSession.create({
      data: {
        absoluteExpiresAt,
        csrfDigest: prepared.newSession.csrfDigest,
        idleExpiresAt,
        tokenDigest: prepared.newSession.tokenDigest,
        userId,
      },
      select: { id: true, userId: true },
    });
    const memberships = await transaction.organizationMembership.findMany({
      where: {
        status: "active",
        userId,
        organization: { status: "active" },
      },
      orderBy: { organizationId: "asc" },
      select: { organizationId: true },
    });
    for (const membership of memberships) {
      await this.audit.append(transaction, {
        action: "authentication.login",
        actorUserId: userId,
        occurredAt: now,
        organizationId: membership.organizationId,
        outcome: "succeeded",
        requestId,
        spaceId: null,
        targetId: created.id,
        targetType: "session",
      });
    }
    return { created, rotated };
  }

  /** 把持久化结果转换为公开认证响应，避免向调用方泄露 token 哈希和内部代次。 */
  #completeSessionIssue(
    prepared: PreparedSessionIssue,
    issued: IssuedSession,
    requestId: string,
  ): LoginResult {
    this.#logger.log({
      authSessionId: issued.created.id,
      event: "auth.session",
      outcome: issued.rotated ? "rotated" : "created",
      requestId,
      userId: issued.created.userId,
    });

    return {
      authSessionId: issued.created.id,
      csrfToken: prepared.newSession.csrfToken,
      tokenValue: prepared.newSession.tokenValue,
      userId: issued.created.userId,
    };
  }

  /** 从请求 token 解析已认证会话；无效、过期或被撤销状态统一收敛为未认证。 */
  authenticate(
    tokenValue: string | undefined,
    requestId: string,
  ): Promise<AuthenticatedSession> {
    return this.#authenticateToken(tokenValue, requestId);
  }

  /** 在认证成功后额外校验 CSRF token，供所有状态变更入口使用。 */
  authenticateWithCsrf(
    tokenValue: string | undefined,
    csrfToken: string | undefined,
    requestId: string,
  ): Promise<AuthenticatedSession> {
    const token =
      tokenValue === undefined ? undefined : sessionTokenFromValue(tokenValue);
    if (token === undefined) {
      this.#logUnauthenticated(requestId);
      throw unauthenticated();
    }
    if (!isMatchingOpaqueToken(csrfToken, token.csrfToken)) {
      this.#logger.warn({
        event: "auth.session",
        outcome: "csrf-rejected",
        requestId,
      });
      throw forbidden();
    }

    return this.#authenticateParsedToken(token, requestId);
  }

  async #authenticateToken(
    tokenValue: string | undefined,
    requestId: string,
  ): Promise<AuthenticatedSession> {
    if (tokenValue === undefined) {
      this.#logUnauthenticated(requestId);
      throw unauthenticated();
    }
    const token = sessionTokenFromValue(tokenValue);
    if (token === undefined) {
      this.#logUnauthenticated(requestId);
      throw unauthenticated();
    }

    return this.#authenticateParsedToken(token, requestId);
  }

  async #authenticateParsedToken(
    token: NonNullable<ReturnType<typeof sessionTokenFromValue>>,
    requestId: string,
  ): Promise<AuthenticatedSession> {
    const rows = await this.database.client.$transaction(async (transaction) => {
      const lockedUsers = await transaction.$queryRaw<LockedSessionUserRow[]>(
        Prisma.sql`
          SELECT account."id" AS "userId", account."status"::text AS "status"
          FROM "users" AS account
          INNER JOIN "auth_sessions" AS session
            ON session."user_id" = account."id"
          WHERE session."token_digest" = ${token.tokenDigest}
          FOR UPDATE OF account
        `,
      );
      const lockedUser = lockedUsers[0];
      if (lockedUser?.status !== "active") {
        return [];
      }
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "auth_sessions"
          WHERE "token_digest" = ${token.tokenDigest}
          FOR UPDATE
        `,
      );
      const now = this.clock.now();
      const nextIdleExpiresAt = new Date(
        now.getTime() + SESSION_IDLE_MILLISECONDS,
      );
      const renewedRows = await transaction.$queryRaw<RenewedSessionRow[]>(
        Prisma.sql`
        UPDATE "auth_sessions" AS session
        SET "idle_expires_at" = LEAST(
          GREATEST(session."idle_expires_at", ${nextIdleExpiresAt}),
          session."absolute_expires_at"
        )
        WHERE session."token_digest" = ${token.tokenDigest}
          AND session."user_id" = ${lockedUser.userId}
          AND session."csrf_digest" = ${token.csrfDigest}
          AND session."revoked_at" IS NULL
          AND ${now} < session."idle_expires_at"
          AND ${now} < session."absolute_expires_at"
        RETURNING
          session."id" AS "authSessionId",
          session."user_id" AS "userId",
          session."idle_expires_at" AS "expiresAt"
      `,
      );
      const renewed = renewedRows[0];
      if (renewed !== undefined) {
        await this.accessChanges.refreshSessionExpiry(transaction, {
          authSessionId: renewed.authSessionId,
          expiresAt: renewed.expiresAt,
          requestId,
        });
      }
      return renewedRows;
    });
    const renewed = rows[0];
    if (renewed === undefined) {
      this.#logUnauthenticated(requestId);
      throw unauthenticated();
    }

    return {
      authSessionId: renewed.authSessionId,
      csrfToken: token.csrfToken,
      userId: renewed.userId,
    };
  }

  /** 按发起时会话代次撤销当前会话，避免旧 logout 响应清理后续新登录。 */
  async revokeCurrentSession(
    session: AuthenticatedSession,
    requestId: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.database.client.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${session.userId} FOR UPDATE`,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "auth_sessions" WHERE "id" = ${session.authSessionId} FOR UPDATE`,
      );
      await transaction.authSession.updateMany({
        where: { id: session.authSessionId, userId: session.userId },
        data: { revokedAt: now },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "unauthenticated",
        requestId,
        selectors: [{ kind: "auth-session", value: session.authSessionId }],
      });
    });
    this.#logger.log({
      authSessionId: session.authSessionId,
      event: "auth.session",
      outcome: "revoked",
      requestId,
      userId: session.userId,
    });
  }

  #logUnauthenticated(requestId: string): void {
    this.#logger.warn({
      event: "auth.session",
      outcome: "unauthenticated",
      requestId,
    });
  }

  /** 在调用方事务内创建用户并返回公开身份 ID，密码哈希由唯一 owner 生成。 */
  async createUserInTransaction(
    transaction: Prisma.TransactionClient,
    input: {
      loginIdentifier: string;
      organizationId: string;
      passwordDigest: string;
    },
  ): Promise<string> {
    const user = await transaction.user.create({
      data: {
        loginIdentifier: input.loginIdentifier,
        passwordDigest: input.passwordDigest,
        status: "active",
        organizationMemberships: {
          create: {
            organizationId: input.organizationId,
            role: "member",
            status: "active",
          },
        },
      },
      select: { id: true },
    });
    return user.id;
  }

  /** 在事务内禁用用户并提升会话代次，令已有 token 立即失效。 */
  async disableUserInTransaction(
    transaction: Prisma.TransactionClient,
    userId: string,
    now: Date,
    requestId: string,
  ): Promise<IdentityTransactionResult> {
    const user = await transaction.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        organizationMemberships: {
          where: { role: "owner", status: "active" },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (user === null) {
      return "not-found";
    }
    if (user.status === "disabled") {
      return "unchanged";
    }
    if (user.organizationMemberships.length > 0) {
      return "conflict";
    }
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "auth_sessions" WHERE "user_id" = ${userId} ORDER BY "id" FOR UPDATE`,
    );
    await transaction.user.update({
      where: { id: userId },
      data: { status: "disabled" },
    });
    await transaction.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await this.accessChanges.publish(transaction, {
      kind: "close",
      reason: "unauthenticated",
      requestId,
      selectors: [{ kind: "user", value: userId }],
    });
    return "updated";
  }

  /** 在事务内撤销用户全部会话并发布认证变化事件，供多实例同步。 */
  async revokeUserSessionsInTransaction(
    transaction: Prisma.TransactionClient,
    userId: string,
    now: Date,
    requestId: string,
  ): Promise<IdentityTransactionResult> {
    const user = await transaction.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (user === null) {
      return "not-found";
    }
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "auth_sessions" WHERE "user_id" = ${userId} ORDER BY "id" FOR UPDATE`,
    );
    const revoked = await transaction.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count === 0) {
      return "unchanged";
    }
    await this.accessChanges.publish(transaction, {
      kind: "close",
      reason: "unauthenticated",
      requestId,
      selectors: [{ kind: "user", value: userId }],
    });
    return "revoked";
  }
}
