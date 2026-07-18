import { Inject, Injectable, Logger } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { AuditWriter } from "../audit/audit-writer.service.js";
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

export type IdentityTransactionResult =
  | "conflict"
  | "not-found"
  | "revoked"
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

  async issueSessionForUser(input: {
    currentTokenValue: string | undefined;
    requestId: string;
    userId: string;
  }): Promise<LoginResult> {
    const database = this.database.client;
    const now = this.clock.now();
    const absoluteExpiresAt = new Date(
      now.getTime() + SESSION_ABSOLUTE_MILLISECONDS,
    );
    const idleExpiresAt = new Date(now.getTime() + SESSION_IDLE_MILLISECONDS);
    const newSession = createSessionToken();
    const currentSession =
      input.currentTokenValue === undefined
        ? undefined
        : sessionTokenFromValue(input.currentTokenValue);
    const currentOwner =
      currentSession === undefined
        ? null
        : await database.authSession.findUnique({
            where: { tokenDigest: currentSession.tokenDigest },
            select: { id: true, userId: true },
          });

    const issued = await database.$transaction(async (transaction) => {
      const userIds = [...new Set([input.userId, currentOwner?.userId])]
        .filter((value): value is string => value !== undefined)
        .sort();
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" IN (${Prisma.join(
          userIds,
        )}) ORDER BY "id" FOR UPDATE`,
      );
      const lockedUser = await transaction.user.findUnique({
        where: { id: input.userId },
        select: { status: true },
      });
      if (lockedUser?.status !== "active") {
        this.#logUnauthenticated(input.requestId);
        throw unauthenticated();
      }

      let rotated = false;
      if (currentSession !== undefined && currentOwner !== null) {
        const revoked = await transaction.authSession.updateMany({
          where: {
            tokenDigest: currentSession.tokenDigest,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        rotated = revoked.count > 0;
        if (rotated) {
          await this.accessChanges.publish(transaction, {
            kind: "close",
            reason: "unauthenticated",
            requestId: input.requestId,
            selectors: [{ kind: "auth-session", value: currentOwner.id }],
          });
        }
      }

      const created = await transaction.authSession.create({
        data: {
          absoluteExpiresAt,
          csrfDigest: newSession.csrfDigest,
          idleExpiresAt,
          tokenDigest: newSession.tokenDigest,
          userId: input.userId,
        },
        select: { id: true, userId: true },
      });
      const memberships = await transaction.organizationMembership.findMany({
        where: {
          status: "active",
          userId: input.userId,
          organization: { status: "active" },
        },
        orderBy: { organizationId: "asc" },
        select: { organizationId: true },
      });
      for (const membership of memberships) {
        await this.audit.append(transaction, {
          action: "authentication.login",
          actorUserId: input.userId,
          occurredAt: now,
          organizationId: membership.organizationId,
          outcome: "succeeded",
          requestId: input.requestId,
          spaceId: null,
          targetId: created.id,
          targetType: "session",
        });
      }
      return { created, rotated };
    });

    this.#logger.log({
      authSessionId: issued.created.id,
      event: "auth.session",
      outcome: issued.rotated ? "rotated" : "created",
      requestId: input.requestId,
      userId: issued.created.userId,
    });

    return {
      authSessionId: issued.created.id,
      csrfToken: newSession.csrfToken,
      tokenValue: newSession.tokenValue,
      userId: issued.created.userId,
    };
  }

  authenticate(
    tokenValue: string | undefined,
    requestId: string,
  ): Promise<AuthenticatedSession> {
    return this.#authenticateToken(tokenValue, requestId);
  }

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
    const now = this.clock.now();
    const nextIdleExpiresAt = new Date(
      now.getTime() + SESSION_IDLE_MILLISECONDS,
    );
    const rows = await this.database.client.$transaction(async (transaction) => {
      const renewedRows = await transaction.$queryRaw<RenewedSessionRow[]>(
        Prisma.sql`
        WITH candidate_session AS MATERIALIZED (
          SELECT "user_id"
          FROM "auth_sessions"
          WHERE "token_digest" = ${token.tokenDigest}
        ),
        locked_user AS MATERIALIZED (
          SELECT account."id"
          FROM "users" AS account
          INNER JOIN candidate_session AS candidate
            ON candidate."user_id" = account."id"
          WHERE account."status" = 'active'::"user_status"
          FOR UPDATE OF account
        )
        UPDATE "auth_sessions" AS session
        SET "idle_expires_at" = LEAST(${nextIdleExpiresAt}, session."absolute_expires_at")
        FROM locked_user AS account
        WHERE session."token_digest" = ${token.tokenDigest}
          AND session."user_id" = account."id"
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
    return "revoked";
  }
}
