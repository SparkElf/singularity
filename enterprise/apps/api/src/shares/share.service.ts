import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CreatedDocumentShare } from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { AuditWriter } from "../audit/audit-writer.service.js";
import type { Clock } from "../identity/clock.js";
import { PasswordHasher } from "../identity/password-hasher.js";
import {
  conflict,
  notFound,
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
import { SharePasswordRateLimiter } from "./share-password-rate-limiter.js";
import {
  SHARE_KERNEL,
  type ManagedDocumentShare,
  type ShareKernelPort,
  type SharedAssetPayload,
  type SharedDocumentPayload,
} from "./share.types.js";

const CHALLENGE_LIFETIME_MILLISECONDS = 15 * 60 * 1_000;

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

interface ChallengeRow {
  absoluteExpiresAt: Date;
  passwordVersion: number;
  tokenDigest: string;
}

export type { CreatedDocumentShare } from "@singularity/contracts";

export interface IssuedShareChallenge {
  cookieName: string;
  cookieValue: string;
  expiresAt: Date;
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

  async changePassword(input: {
    actorUserId: string;
    organizationId: string;
    password: string | null;
    requestId: string;
    shareId: string;
    spaceId: string;
  }): Promise<void> {
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

  async issueChallenge(input: {
    password: string;
    requestId: string;
    shareToken: string;
    sourceAddress: string;
  }): Promise<IssuedShareChallenge> {
    const now = this.clock.now();
    const share = await this.#activeShare(input.shareToken, now);
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
    const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MILLISECONDS);
    await this.database.client.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`
          DELETE FROM "share_challenges"
          WHERE "share_id" = ${share.shareId}::uuid
            AND "absolute_expires_at" <= ${now}
        `,
      );
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "share_challenges" (
            "id", "share_id", "token_digest", "password_version",
            "absolute_expires_at", "created_at"
          ) VALUES (
            ${challenge.challengeId}::uuid, ${share.shareId}::uuid,
            ${challenge.digest}, ${share.passwordVersion}, ${expiresAt}, ${now}
          )
        `,
      );
    });
    this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "password-accepted");
    return {
      cookieName: shareChallengeCookieName(share.shareId),
      cookieValue: challenge.value,
      expiresAt,
    };
  }

  async readDocument(input: {
    cookies: Readonly<Record<string, string | undefined>>;
    requestId: string;
    shareToken: string;
    sourceAddress: string;
  }): Promise<SharedDocumentPayload> {
    const share = await this.#authorizeRead(input);
    const payload = await this.kernel.readDocument({
      documentId: share.documentId,
      notebookId: share.notebookId,
      organizationId: share.organizationId,
      requestId: input.requestId,
      spaceId: share.spaceId,
    });
    if (payload === null) {
      throw notFound();
    }
    for (const asset of payload.assets) {
      payload.html = payload.html.replaceAll(
        `singularity-share-asset:${asset.assetId}`,
        `/api/v1/shares/${encodeURIComponent(input.shareToken)}/assets/${asset.assetId}`,
      );
    }
    this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "allowed");
    return payload;
  }

  async readAsset(input: {
    assetId: string;
    cookies: Readonly<Record<string, string | undefined>>;
    requestId: string;
    shareToken: string;
    sourceAddress: string;
  }): Promise<SharedAssetPayload> {
    const share = await this.#authorizeRead(input);
    const payload = await this.kernel.readAsset({
      assetId: input.assetId,
      documentId: share.documentId,
      notebookId: share.notebookId,
      organizationId: share.organizationId,
      requestId: input.requestId,
      spaceId: share.spaceId,
    });
    if (payload === null) {
      throw notFound();
    }
    this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "allowed");
    return payload;
  }

  async #authorizeRead(input: {
    cookies: Readonly<Record<string, string | undefined>>;
    requestId: string;
    shareToken: string;
    sourceAddress: string;
  }): Promise<ShareRow> {
    const now = this.clock.now();
    const share = await this.#activeShare(input.shareToken, now);
    if (share.passwordDigest === null) {
      return share;
    }
    const parsed = parseShareChallenge(
      input.cookies[shareChallengeCookieName(share.shareId)],
    );
    if (parsed === null) {
      this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "challenge-required");
      throw unauthenticated();
    }
    const rows = await this.database.client.$queryRaw<ChallengeRow[]>(
      Prisma.sql`
        SELECT
          "token_digest" AS "tokenDigest",
          "password_version" AS "passwordVersion",
          "absolute_expires_at" AS "absoluteExpiresAt"
        FROM "share_challenges"
        WHERE "id" = ${parsed.challengeId}::uuid
          AND "share_id" = ${share.shareId}::uuid
          AND "absolute_expires_at" > ${now}
      `,
    );
    const challenge = rows[0];
    if (
      challenge === undefined ||
      challenge.passwordVersion !== share.passwordVersion ||
      !challengeDigestMatches(parsed.digest, challenge.tokenDigest)
    ) {
      this.#logAccess(share.shareId, input.sourceAddress, input.requestId, "challenge-denied");
      throw unauthenticated();
    }
    return share;
  }

  async #activeShare(shareToken: string, now: Date): Promise<ShareRow> {
    let tokenDigest: string;
    try {
      tokenDigest = shareTokenDigest(shareToken);
    } catch {
      throw notFound();
    }
    const rows = await this.database.client.$queryRaw<ShareRow[]>(
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
          share."created_at" AS "createdAt"
        FROM "document_shares" AS share
        INNER JOIN "organizations" AS organization
          ON organization."id" = share."organization_id"
        INNER JOIN "spaces" AS space
          ON space."id" = share."space_id"
          AND space."organization_id" = share."organization_id"
        WHERE share."token_digest" = ${tokenDigest}
          AND share."revoked_at" IS NULL
          AND share."expires_at" > ${now}
          AND organization."status" = 'active'::"organization_status"
          AND space."status" = 'active'::"space_status"
        LIMIT 1
      `,
    );
    const share = rows[0];
    if (share === undefined) {
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
    const sourceDigest = createHash("sha256")
      .update("singularity.share-source.v1", "utf8")
      .update(Buffer.from([0]))
      .update(sourceAddress, "utf8")
      .digest("hex");
    const context = {
      event: "share.access",
      outcome,
      requestId,
      shareId,
      sourceDigest,
    };
    if (outcome === "allowed" || outcome === "password-accepted") {
      this.#logger.debug(context);
    } else {
      this.#logger.warn(context);
    }
  }
}
