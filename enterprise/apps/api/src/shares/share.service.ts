import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CreatedDocumentShare } from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import type { Clock } from "../identity/clock.js";
import { PasswordHasher } from "../identity/password-hasher.js";
import {
  conflict,
  notFound,
  serviceUnavailable,
  unauthenticated,
  validationFailed,
} from "../problem.js";
import { SpaceManagementService } from "../spaces/space-management.service.js";
import { CLOCK } from "../tokens.js";
import {
  challengeDigestMatches,
  createShareChallenge,
  createShareToken,
  parseShareChallenge,
  shareChallengeCookieName,
  shareTokenDigest,
} from "./share-credentials.js";
import {
  SharePasswordRateLimiter,
  shareSourceDigest,
} from "./share-password-rate-limiter.js";
import {
  SHARE_KERNEL,
  type ManagedDocumentShare,
  type ShareKernelPort,
  type SharedAssetPayload,
  type SharedDocumentPayload,
} from "./share.types.js";

const CHALLENGE_LIFETIME_MILLISECONDS = 15 * 60 * 1_000;
const SHARE_RESPONSE_LIFETIME_MILLISECONDS = 5 * 60 * 1_000;
const SHARE_READ_LEASE_TIMEOUT_MILLISECONDS = 24 * 60 * 60 * 1_000;

interface ShareRow {
  createdAt: Date;
  documentId: string;
  expiresAt: Date;
  notebookId: string;
  organizationId: string;
  passwordDigest: string | null;
  passwordVersion: number;
  revokedAt: Date | null;
  shareId: string;
  spaceId: string;
}

interface ShareAccessRow extends ShareRow {
  organizationStatus: string;
  spaceStatus: string;
}

interface ChallengeShareState {
  expiresAt: Date;
  passwordDigest: string | null;
  passwordVersion: number;
  revokedAt: Date | null;
}

interface AuthorizedChallengeRow extends ShareRow {
  challengeTokenDigest: string;
}

export type { CreatedDocumentShare } from "@singularity/contracts";

export interface IssuedShareChallenge {
  cookieName: string;
  cookieValue: string;
  expiresAt: Date;
}

export interface SharedReadLease<Payload> {
  payload: Payload;
  release(): Promise<void>;
  terminateAtMilliseconds: number;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  reject(reason: unknown): void;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete, fail) => {
    reject = fail;
    resolve = complete;
  });
  return { promise, reject, resolve };
}

function managedShare(row: ShareRow): ManagedDocumentShare {
  return {
    createdAt: row.createdAt.toISOString(),
    documentId: row.documentId,
    expiresAt: row.expiresAt.toISOString(),
    hasPassword: row.passwordDigest !== null,
    notebookId: row.notebookId,
    organizationId: row.organizationId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    shareId: row.shareId,
    spaceId: row.spaceId,
  };
}

function projectSharedDocument(
  payload: SharedDocumentPayload,
  shareToken: string,
): SharedDocumentPayload {
  const assetIds = new Set(payload.assets.map((asset) => asset.assetId));
  const html = payload.html.replace(
    /singularity-share-asset:([a-f0-9]{64})/g,
    (placeholder, assetId: string) =>
      assetIds.has(assetId)
        ? `/api/v1/shares/${encodeURIComponent(shareToken)}/assets/${assetId}`
        : placeholder,
  );
  return { assets: payload.assets, html, title: payload.title };
}

@Injectable()
export class ShareService {
  readonly #logger = new Logger("ShareService");

  constructor(
    private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly database: DatabaseRuntime,
    @Inject(SHARE_KERNEL) private readonly kernel: ShareKernelPort,
    private readonly passwordHasher: PasswordHasher,
    private readonly passwordRateLimiter: SharePasswordRateLimiter,
    private readonly spaces: SpaceManagementService,
  ) {}

  /** 查询空间管理员可见的分享摘要，不返回 token 原文或密码摘要。 */
  async listShares(input: {
    actorUserId: string;
    organizationId: string;
    spaceId: string;
  }): Promise<ManagedDocumentShare[]> {
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.organizationId,
      input.spaceId,
    );
    const rows = await this.database.client.$queryRaw<ShareRow[]>(
      Prisma.sql`
        SELECT
          "id" AS "shareId",
          "organization_id" AS "organizationId",
          "space_id" AS "spaceId",
          "notebook_id" AS "notebookId",
          "document_id" AS "documentId",
          "password_digest" AS "passwordDigest",
          "password_version" AS "passwordVersion",
          "expires_at" AS "expiresAt",
          "revoked_at" AS "revokedAt",
          "created_at" AS "createdAt"
        FROM "document_shares"
        WHERE "organization_id" = ${input.organizationId}::uuid
          AND "space_id" = ${input.spaceId}::uuid
        ORDER BY "created_at" DESC, "id" ASC
      `,
    );
    return rows.map(managedShare);
  }

  /** 在空间管理授权和 Kernel 文档归属确认后创建可撤销的只读分享事实。 */
  async createShare(input: {
    actorUserId: string;
    documentId: string;
    expiresAt: Date;
    notebookId: string;
    organizationId: string;
    password: string | null;
    requestId: string;
    spaceId: string;
  }): Promise<CreatedDocumentShare> {
    const now = this.clock.now();
    if (input.expiresAt <= now) {
      throw validationFailed();
    }
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.organizationId,
      input.spaceId,
    );
    if (!(await this.kernel.verifyDocument(input))) {
      throw notFound();
    }
    const passwordDigest =
      input.password === null
        ? null
        : await this.passwordHasher.hashPassword(input.password);
    const token = createShareToken();
    const shareId = randomUUID();
    const row = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
        input.spaceId,
      );
      const rows = await transaction.$queryRaw<ShareRow[]>(
        Prisma.sql`
          INSERT INTO "document_shares" (
            "id", "organization_id", "space_id", "notebook_id", "document_id",
            "token_digest", "password_digest", "password_version", "expires_at",
            "created_by_user_id", "created_at"
          ) VALUES (
            ${shareId}::uuid, ${input.organizationId}::uuid,
            ${input.spaceId}::uuid, ${input.notebookId}, ${input.documentId},
            ${token.digest}, ${passwordDigest}, 1, ${input.expiresAt},
            ${input.actorUserId}::uuid, ${now}
          )
          RETURNING
            "id" AS "shareId",
            "organization_id" AS "organizationId",
            "space_id" AS "spaceId",
            "notebook_id" AS "notebookId",
            "document_id" AS "documentId",
            "password_digest" AS "passwordDigest",
            "password_version" AS "passwordVersion",
            "expires_at" AS "expiresAt",
            "revoked_at" AS "revokedAt",
            "created_at" AS "createdAt"
        `,
      );
      const created = rows[0];
      if (created === undefined) {
        throw new Error("Document share creation failed");
      }
      await this.audit.append(transaction, {
        action: "share.create",
        actorUserId: input.actorUserId,
        occurredAt: now,
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.spaceId,
        targetId: shareId,
        targetType: "share",
      });
      return created;
    });
    return { ...managedShare(row), shareToken: token.value };
  }

  /** 在同一事务内锁定分享并递增密码版本，使旧挑战不能继续授权。 */
  async changePassword(input: {
    actorUserId: string;
    organizationId: string;
    password: string | null;
    requestId: string;
    shareId: string;
    spaceId: string;
  }): Promise<void> {
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.organizationId,
      input.spaceId,
    );
    const passwordDigest =
      input.password === null
        ? null
        : await this.passwordHasher.hashPassword(input.password);
    const now = this.clock.now();
    await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
        input.spaceId,
      );
      const count = await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "document_shares"
          SET
            "password_digest" = ${passwordDigest},
            "password_version" = "password_version" + 1
          WHERE "id" = ${input.shareId}::uuid
            AND "organization_id" = ${input.organizationId}::uuid
            AND "space_id" = ${input.spaceId}::uuid
            AND "revoked_at" IS NULL
        `,
      );
      if (count !== 1) {
        throw notFound();
      }
      await transaction.$executeRaw(
        Prisma.sql`DELETE FROM "share_challenges" WHERE "share_id" = ${input.shareId}::uuid`,
      );
      await this.audit.append(transaction, {
        action: "share.password-change",
        actorUserId: input.actorUserId,
        occurredAt: now,
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.spaceId,
        targetId: input.shareId,
        targetType: "share",
      });
    });
  }

  /** 在同一事务内标记分享撤销、删除挑战并写入审计事件。 */
  async revokeShare(input: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    shareId: string;
    spaceId: string;
  }): Promise<void> {
    const now = this.clock.now();
    await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
        input.spaceId,
      );
      const count = await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "document_shares"
          SET "revoked_at" = ${now}
          WHERE "id" = ${input.shareId}::uuid
            AND "organization_id" = ${input.organizationId}::uuid
            AND "space_id" = ${input.spaceId}::uuid
            AND "revoked_at" IS NULL
        `,
      );
      if (count !== 1) {
        throw notFound();
      }
      await transaction.$executeRaw(
        Prisma.sql`DELETE FROM "share_challenges" WHERE "share_id" = ${input.shareId}::uuid`,
      );
      await this.audit.append(transaction, {
        action: "share.revoke",
        actorUserId: input.actorUserId,
        occurredAt: now,
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.spaceId,
        targetId: input.shareId,
        targetType: "share",
      });
    });
  }

  /** 校验分享密码并原子签发带密码版本的挑战 token，旧版本挑战不能继续使用。 */
  async issueChallenge(input: {
    password: string;
    requestId: string;
    shareToken: string;
    sourceAddress: string;
  }): Promise<IssuedShareChallenge> {
    const share = await this.#activeShare(input.shareToken);
    if (share.passwordDigest === null) {
      throw conflict();
    }
    await this.passwordRateLimiter.consume(
      input.sourceAddress,
      share.shareId,
      input.requestId,
    );
    const matches = await this.passwordHasher.verifyPassword(
      share.passwordDigest,
      input.password,
    );
    if (!matches) {
      this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "password-denied");
      throw unauthenticated();
    }

    const challenge = createShareChallenge();
    let expiresAt: Date | undefined;
    await this.database.client.$transaction(async (transaction) => {
      const current = await this.#lockChallengeShare(
        transaction,
        share,
        input.shareToken,
      );
      const lockedAt = this.clock.now();
      if (current.revokedAt !== null || current.expiresAt <= lockedAt) {
        throw notFound();
      }
      if (current.passwordDigest === null) {
        throw conflict();
      }
      if (
        current.passwordVersion !== share.passwordVersion ||
        current.passwordDigest !== share.passwordDigest
      ) {
        throw unauthenticated();
      }
      expiresAt = new Date(
        lockedAt.getTime() + CHALLENGE_LIFETIME_MILLISECONDS,
      );
      await transaction.$executeRaw(
        Prisma.sql`
          DELETE FROM "share_challenges"
          WHERE "share_id" = ${share.shareId}::uuid
            AND "absolute_expires_at" <= ${lockedAt}
        `,
      );
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "share_challenges" (
            "id", "share_id", "token_digest", "password_version",
            "absolute_expires_at", "created_at"
          ) VALUES (
            ${challenge.challengeId}::uuid, ${share.shareId}::uuid,
            ${challenge.digest}, ${current.passwordVersion}, ${expiresAt}, ${lockedAt}
          )
        `,
      );
    });
    if (expiresAt === undefined) {
      throw new Error("Share challenge transaction completed without a lease");
    }
    this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "password-accepted");
    return {
      cookieName: shareChallengeCookieName(share.shareId),
      cookieValue: challenge.value,
      expiresAt,
    };
  }

  /** 获取分享文档公开投影，并让读锁覆盖 Kernel 读取到 HTTP 响应完成。 */
  async readDocument(input: {
    cookies: Readonly<Record<string, string | undefined>>;
    requestId: string;
    shareToken: string;
    signal: AbortSignal;
    sourceAddress: string;
  }): Promise<SharedReadLease<SharedDocumentPayload>> {
    return this.#withReadLease(input, async (share) => {
      const payload = await this.kernel.readDocument({
        documentId: share.documentId,
        notebookId: share.notebookId,
        organizationId: share.organizationId,
        requestId: input.requestId,
        signal: input.signal,
        spaceId: share.spaceId,
      });
      return payload === null
        ? null
        : projectSharedDocument(payload, input.shareToken);
    });
  }

  /** 获取分享资产流；锁和流的释放由公开响应 owner 在完成或终止时触发。 */
  async readAsset(input: {
    assetId: string;
    cookies: Readonly<Record<string, string | undefined>>;
    requestId: string;
    shareToken: string;
    signal: AbortSignal;
    sourceAddress: string;
  }): Promise<SharedReadLease<SharedAssetPayload>> {
    return this.#withReadLease(input, (share) =>
      this.kernel.readAsset({
        assetId: input.assetId,
        documentId: share.documentId,
        notebookId: share.notebookId,
        organizationId: share.organizationId,
        requestId: input.requestId,
        signal: input.signal,
        spaceId: share.spaceId,
      })
    );
  }

  /** 以数据库行锁串行化读取与撤销/改密，避免旧响应在控制面变更后继续泄露内容。 */
  async #withReadLease<Payload>(
    input: {
      cookies: Readonly<Record<string, string | undefined>>;
      requestId: string;
      shareToken: string;
      sourceAddress: string;
    },
    read: (share: ShareRow) => Promise<Payload | null>,
  ): Promise<SharedReadLease<Payload>> {
    const terminateAtMilliseconds =
      Date.now() + SHARE_RESPONSE_LIFETIME_MILLISECONDS;
    const ready = deferred<Payload>();
    const releaseGate = deferred<void>();
    let delivered = false;
    const transaction = this.database.client.$transaction(async (client) => {
      try {
        const share = await this.#authorizeRead(input, client, true);
        const payload = await read(share);
        if (payload === null) {
          throw notFound();
        }
        if (Date.now() >= terminateAtMilliseconds) {
          throw serviceUnavailable();
        }
        this.#logAccess(
          share.shareId,
          input.sourceAddress,
          input.requestId,
          "allowed",
        );
        delivered = true;
        ready.resolve(payload);
        await releaseGate.promise;
      } catch (error) {
        if (!delivered) {
          ready.reject(error);
        }
        throw error;
      }
    }, { timeout: SHARE_READ_LEASE_TIMEOUT_MILLISECONDS });
    const outcome = transaction.then(
      () => null,
      (error: unknown) => error,
    );
    const payload = await ready.promise;
    let released = false;
    return {
      payload,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        releaseGate.resolve();
        const error = await outcome;
        if (error !== null) {
          const observed = error instanceof Error
            ? error
            : new Error("Share read lease failed", { cause: error });
          this.#logger.error(
            { event: "share.read-lease", result: "failed" },
            observed.stack,
          );
        }
      },
      terminateAtMilliseconds,
    };
  }

  /** 在挑战事务内锁定分享并读取最新密码版本，串行化改密、撤销与挑战签发。 */
  async #lockChallengeShare(
    transaction: Prisma.TransactionClient,
    share: ShareRow,
    shareToken: string,
  ): Promise<ChallengeShareState> {
    const organizations = await transaction.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "organizations"
        WHERE "id" = ${share.organizationId}::uuid
        FOR UPDATE
      `,
    );
    if (organizations[0]?.status !== "active") {
      throw notFound();
    }
    const spaces = await transaction.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "spaces"
        WHERE "id" = ${share.spaceId}::uuid
          AND "organization_id" = ${share.organizationId}::uuid
        FOR UPDATE
      `,
    );
    if (spaces[0]?.status !== "active") {
      throw notFound();
    }
    const rows = await transaction.$queryRaw<ChallengeShareState[]>(
      Prisma.sql`
        SELECT
          "password_digest" AS "passwordDigest",
          "password_version" AS "passwordVersion",
          "expires_at" AS "expiresAt",
          "revoked_at" AS "revokedAt"
        FROM "document_shares"
        WHERE "id" = ${share.shareId}::uuid
          AND "organization_id" = ${share.organizationId}::uuid
          AND "space_id" = ${share.spaceId}::uuid
          AND "token_digest" = ${shareTokenDigest(shareToken)}
        FOR UPDATE
      `,
    );
    const current = rows[0];
    if (current === undefined) {
      throw notFound();
    }
    return current;
  }

  /** 校验公开分享 token 或挑战 cookie，并返回可用于内容读取的分享事实。 */
  async #authorizeRead(input: {
    cookies: Readonly<Record<string, string | undefined>>;
    requestId: string;
    shareToken: string;
    sourceAddress: string;
  }, client: Pick<Prisma.TransactionClient, "$queryRaw"> = this.database.client, lock = false): Promise<ShareRow> {
    const share = await this.#activeShare(input.shareToken, client, lock);
    if (share.passwordDigest === null) {
      return share;
    }
    const now = this.clock.now();
    const parsed = parseShareChallenge(
      input.cookies[shareChallengeCookieName(share.shareId)],
    );
    if (parsed === null) {
      this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "challenge-required");
      throw unauthenticated();
    }
    const rows = await client.$queryRaw<AuthorizedChallengeRow[]>(
      Prisma.sql`
        SELECT
          share."id" AS "shareId",
          share."organization_id" AS "organizationId",
          share."space_id" AS "spaceId",
          share."notebook_id" AS "notebookId",
          share."document_id" AS "documentId",
          share."password_digest" AS "passwordDigest",
          share."password_version" AS "passwordVersion",
          share."expires_at" AS "expiresAt",
          share."revoked_at" AS "revokedAt",
          share."created_at" AS "createdAt",
          challenge."token_digest" AS "challengeTokenDigest"
        FROM "share_challenges" AS challenge
        INNER JOIN "document_shares" AS share
          ON share."id" = challenge."share_id"
        INNER JOIN "organizations" AS organization
          ON organization."id" = share."organization_id"
        INNER JOIN "spaces" AS space
          ON space."id" = share."space_id"
          AND space."organization_id" = share."organization_id"
        WHERE challenge."id" = ${parsed.challengeId}::uuid
          AND challenge."share_id" = ${share.shareId}::uuid
          AND challenge."password_version" = share."password_version"
          AND challenge."absolute_expires_at" > ${now}
          AND share."token_digest" = ${shareTokenDigest(input.shareToken)}
          AND share."password_digest" IS NOT NULL
          AND share."revoked_at" IS NULL
          AND share."expires_at" > ${now}
          AND organization."status" = 'active'::"organization_status"
          AND space."status" = 'active'::"space_status"
        LIMIT 1
      `,
    );
    const challenge = rows[0];
    if (
      challenge === undefined ||
      !challengeDigestMatches(parsed.digest, challenge.challengeTokenDigest)
    ) {
      this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "challenge-denied");
      throw unauthenticated();
    }
    return challenge;
  }

  /** 读取未过期且未撤销的分享记录，统一拥有 token 摘要边界。 */
  async #activeShare(
    shareToken: string,
    client: Pick<Prisma.TransactionClient, "$queryRaw"> = this.database.client,
    lock = false,
  ): Promise<ShareRow> {
    const tokenDigest = shareTokenDigest(shareToken);
    const query = lock
      ? Prisma.sql`
        SELECT
          share."id" AS "shareId",
          share."organization_id" AS "organizationId",
          share."space_id" AS "spaceId",
          share."notebook_id" AS "notebookId",
          share."document_id" AS "documentId",
          share."password_digest" AS "passwordDigest",
          share."password_version" AS "passwordVersion",
          share."expires_at" AS "expiresAt",
          share."revoked_at" AS "revokedAt",
          share."created_at" AS "createdAt",
          organization."status"::text AS "organizationStatus",
          space."status"::text AS "spaceStatus"
        FROM "document_shares" AS share
        INNER JOIN "organizations" AS organization
          ON organization."id" = share."organization_id"
        INNER JOIN "spaces" AS space
          ON space."id" = share."space_id"
          AND space."organization_id" = share."organization_id"
        WHERE share."token_digest" = ${tokenDigest}
        LIMIT 1
        FOR SHARE OF share
      `
      : Prisma.sql`
        SELECT
          share."id" AS "shareId",
          share."organization_id" AS "organizationId",
          share."space_id" AS "spaceId",
          share."notebook_id" AS "notebookId",
          share."document_id" AS "documentId",
          share."password_digest" AS "passwordDigest",
          share."password_version" AS "passwordVersion",
          share."expires_at" AS "expiresAt",
          share."revoked_at" AS "revokedAt",
          share."created_at" AS "createdAt",
          organization."status"::text AS "organizationStatus",
          space."status"::text AS "spaceStatus"
        FROM "document_shares" AS share
        INNER JOIN "organizations" AS organization
          ON organization."id" = share."organization_id"
        INNER JOIN "spaces" AS space
          ON space."id" = share."space_id"
          AND space."organization_id" = share."organization_id"
        WHERE share."token_digest" = ${tokenDigest}
        LIMIT 1
      `;
    const rows = await client.$queryRaw<ShareAccessRow[]>(query);
    const share = rows[0];
    const observedAt = this.clock.now();
    if (
      share === undefined ||
      share.revokedAt !== null ||
      share.expiresAt <= observedAt ||
      share.organizationStatus !== "active" ||
      share.spaceStatus !== "active"
    ) {
      throw notFound();
    }
    return share;
  }

  #logAccess(
    shareId: string,
    sourceAddress: string,
    requestId: string,
    outcome: string,
  ): void {
    const context = {
      event: "share.access",
      outcome,
      requestId,
      shareId,
      sourceDigest: shareSourceDigest(sourceAddress),
    };
    if (outcome === "allowed" || outcome === "password-accepted") {
      this.#logger.debug(context);
    } else {
      this.#logger.warn(context);
    }
  }
}
