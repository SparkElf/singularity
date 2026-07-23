import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  MfaFactorRequest,
  MfaLoginChallengeResponse,
  MfaLoginChallengeVerifyRequest,
  MfaVerifyRequest,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { serviceUnavailable, unauthenticated, notFound } from "../problem.js";
import { CLOCK } from "../tokens.js";
import type { Clock } from "./clock.js";

const CHALLENGE_LIFETIME_MILLISECONDS = 5 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;

function digest(value: string): string {
  return createHash("sha256").update("singularity.mfa.challenge.v1").update("\0").update(value).digest("hex");
}

@Injectable()
export class MfaService {
  readonly #logger = new Logger("MfaService");

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 创建未启用的 TOTP 因子；密钥只以 AES-GCM 信封形式进入数据库。 */
  async enroll(actorUserId: string, input: MfaFactorRequest, requestId: string) {
    const encryptedSecret = this.#encryptSecret(input.secret);
    const factor = await this.database.client.mfaFactor.upsert({
      where: { userId_label: { userId: actorUserId, label: input.label } },
      create: { userId: actorUserId, label: input.label, encryptedSecret },
      update: { encryptedSecret, enabledAt: null, lastUsedAt: null },
    });
    this.#logger.log({ event: "identity.mfa.enrolled", factorId: factor.id, requestId, userId: actorUserId });
    return { factorId: factor.id, label: factor.label, requiresVerification: true };
  }

  /** 验证绑定阶段的验证码，并在成功后启用因子。 */
  async verify(actorUserId: string, input: MfaVerifyRequest, requestId: string): Promise<{ enabled: boolean }> {
    const factor = await this.database.client.mfaFactor.findUnique({ where: { userId_label: { userId: actorUserId, label: input.label } } });
    if (factor === null) {
      throw notFound();
    }
    const accepted = this.#acceptsCode(this.#decryptSecret(factor.encryptedSecret), input.code);
    if (!accepted) {
      this.#logger.warn({ event: "identity.mfa.verification-failed", factorId: factor.id, requestId, userId: actorUserId });
      throw unauthenticated();
    }
    await this.database.client.mfaFactor.update({ where: { id: factor.id }, data: { enabledAt: factor.enabledAt ?? this.clock.now(), lastUsedAt: this.clock.now() } });
    return { enabled: true };
  }

  /** 返回当前用户的 MFA 元数据；只暴露启用状态和时间，不返回加密密钥或可重放材料。 */
  async listFactors(actorUserId: string) {
    const factors = await this.database.client.mfaFactor.findMany({
      where: { userId: actorUserId },
      orderBy: { createdAt: "asc" },
    });
    return {
      factors: factors.map((factor) => ({
        createdAt: factor.createdAt.toISOString(),
        enabled: factor.enabledAt !== null,
        factorId: factor.id,
        label: factor.label,
        ...(factor.lastUsedAt === null ? {} : { lastUsedAt: factor.lastUsedAt.toISOString() }),
      })),
    };
  }

  /** 判断用户是否已经启用至少一个 MFA 因子，供密码成功后的登录分流使用。 */
  hasEnabledFactor(userId: string): Promise<boolean> {
    return this.database.client.mfaFactor.count({ where: { userId, enabledAt: { not: null } } }).then((count) => count > 0);
  }

  /** 为密码已通过的登录创建一次性 challenge；数据库和日志只保存摘要。 */
  async createLoginChallenge(userId: string): Promise<MfaLoginChallengeResponse> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.clock.now().getTime() + CHALLENGE_LIFETIME_MILLISECONDS);
    await this.database.client.mfaLoginChallenge.create({
      data: { expiresAt, tokenDigest: digest(token), userId },
    });
    return { challengeToken: token, expiresAt: expiresAt.toISOString() };
  }

  /** 校验并消费登录 challenge，成功后返回用户 ID 供现有会话签发器使用。 */
  async verifyLoginChallenge(input: MfaLoginChallengeVerifyRequest, requestId: string): Promise<{ userId: string }> {
    const now = this.clock.now();
    return this.database.client.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "mfa_login_challenges" WHERE "token_digest" = ${digest(input.challengeToken)} FOR UPDATE`);
      const challenge = await transaction.mfaLoginChallenge.findUnique({ where: { tokenDigest: digest(input.challengeToken) } });
      if (challenge === null || challenge.consumedAt !== null || challenge.expiresAt <= now || challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
        this.#logger.warn({ event: "identity.mfa.challenge-rejected", outcome: "expired-or-consumed", requestId });
        throw unauthenticated();
      }
      const factors = await transaction.mfaFactor.findMany({ where: { userId: challenge.userId, enabledAt: { not: null } }, orderBy: { enabledAt: "asc" } });
      // 一个 challenge 可由用户任一已启用因子完成；成功后只更新实际匹配的因子，避免多因子账号被首个因子绑定。
      const factor = factors.find((candidate) => this.#acceptsCode(this.#decryptSecret(candidate.encryptedSecret), input.code));
      if (factor === undefined) {
        await transaction.mfaLoginChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
        this.#logger.warn({ event: "identity.mfa.challenge-rejected", outcome: "code-invalid", requestId });
        throw unauthenticated();
      }
      await transaction.mfaLoginChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
      await transaction.mfaFactor.update({ where: { id: factor.id }, data: { lastUsedAt: now } });
      return { userId: challenge.userId };
    });
  }

  #acceptsCode(secret: string, code: string): boolean {
    const currentCounter = Math.floor(this.clock.now().getTime() / 30_000);
    return [-1, 0, 1].some((offset) => {
      const generated = Buffer.from(this.#totp(secret, currentCounter + offset), "ascii");
      const provided = Buffer.from(code, "ascii");
      return generated.byteLength === provided.byteLength && timingSafeEqual(generated, provided);
    });
  }

  #key() {
    const encoded = process.env.SINGULARITY_MFA_ENCRYPTION_KEY;
    if (encoded === undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw serviceUnavailable({ cause: new Error("MFA encryption key is unavailable") });
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
      throw serviceUnavailable({ cause: new Error("MFA encryption key has invalid length") });
    }
    return createSecretKey(key);
  }

  #encryptSecret(secret: string): string {
    const normalized = secret.replace(/[ =-]/g, "").toUpperCase();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key(), iv);
    const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
  }

  #decryptSecret(value: string): string {
    const [version, ivValue, tagValue, ciphertextValue] = value.split(":");
    if (version !== "v1" || ivValue === undefined || tagValue === undefined || ciphertextValue === undefined) {
      throw serviceUnavailable({ cause: new Error("MFA secret envelope is invalid") });
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key(), Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
    } catch (error) {
      throw serviceUnavailable({ cause: error });
    }
  }

  #totp(secret: string, counter: number): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bits = [...secret].map((character) => {
      const index = alphabet.indexOf(character);
      if (index < 0) {
        throw serviceUnavailable({ cause: new Error("MFA secret format is invalid") });
      }
      return index.toString(2).padStart(5, "0");
    }).join("");
    const bytes = Buffer.alloc(Math.floor(bits.length / 8));
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
    }
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(BigInt(counter));
    const digestValue = createHmac("sha1", bytes).update(counterBytes).digest();
    const offset = digestValue[digestValue.length - 1]! & 0x0f;
    const value = ((digestValue[offset]! & 0x7f) << 24) | ((digestValue[offset + 1]! & 0xff) << 16) | ((digestValue[offset + 2]! & 0xff) << 8) | (digestValue[offset + 3]! & 0xff);
    return String(value % 1_000_000).padStart(6, "0");
  }
}
