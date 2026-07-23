import { Injectable, Inject, Logger } from "@nestjs/common";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { DatabaseRuntime } from "@singularity/database";

import { AUTH_SAML_CALLBACK_PATH } from "@singularity/contracts";
import type { ApiConfiguration } from "../configuration.js";
import { unauthenticated, notFound, serviceUnavailable } from "../problem.js";
import { API_CONFIGURATION } from "../tokens.js";
import { IdentityService, type LoginResult } from "./identity.service.js";

@Injectable()
export class SamlService {
  readonly #logger = new Logger("SamlService");
  // 单副本部署内复用同一 SAML 客户端，保留 node-saml 的 InResponseTo 请求缓存；
  // 回调重建客户端会丢失已发出的 AuthnRequest，导致校验失效并允许重放。
  readonly #clients = new Map<string, SAML>();

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly identity: IdentityService,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
  ) {}

  /** 生成 IdP 登录地址；RelayState 只携带请求关联 ID，不把本地会话或内容身份交给 IdP。 */
  async authorize(providerId: string, requestId: string): Promise<{ location: string }> {
    const provider = await this.database.client.samlProvider.findUnique({ where: { id: providerId } });
    if (provider === null || provider.status !== "active") {
      throw notFound();
    }
    try {
      const saml = this.#client(provider.id, provider);
      const location = await saml.getAuthorizeUrlAsync(requestId, undefined, {});
      return { location };
    } catch (error) {
      this.#logger.error({ error, event: "identity.saml.start", outcome: "failed", providerId, requestId });
      throw serviceUnavailable({ cause: error });
    }
  }

  /** 验证 IdP 断言并映射到组织内已有用户，断言正文不写入控制面或日志。 */
  async authenticate(input: {
    currentTokenValue: string | undefined;
    encodedResponse: string;
    providerId: string;
    requestId: string;
  }): Promise<LoginResult> {
    const provider = await this.database.client.samlProvider.findUnique({ where: { id: input.providerId } });
    if (provider === null || provider.status !== "active") {
      throw notFound();
    }
    try {
      const saml = this.#client(provider.id, provider);
      const result = await saml.validatePostResponseAsync({ SAMLResponse: input.encodedResponse });
      const profile = result.profile;
      if (profile === null || result.loggedOut) {
        throw unauthenticated();
      }
      const identifier = (profile.email ?? profile.mail ?? profile.nameID ?? "").trim().toLowerCase();
      if (identifier.length === 0) {
        throw unauthenticated();
      }
      const membership = await this.database.client.organizationMembership.findFirst({
        where: {
          organizationId: provider.organizationId,
          status: "active",
          user: { loginIdentifier: identifier, status: "active" },
        },
        select: { userId: true },
      });
      if (membership === null) {
        throw unauthenticated();
      }
      return this.identity.issueSessionForUser({
        currentTokenValue: input.currentTokenValue,
        requestId: input.requestId,
        userId: membership.userId,
      });
    } catch (error) {
      this.#logger.error({ event: "identity.saml.callback", error, outcome: "rejected", providerId: provider.id, requestId: input.requestId });
      if (error instanceof Error && error.name === "ApiProblemError") {
        throw error;
      }
      throw serviceUnavailable({ cause: error });
    }
  }

  /** 创建并缓存 provider 级 SAML 客户端，让请求 ID 在发起与回调之间可验证且一次性消费。 */
  #client(providerId: string, provider: { certificatePem: string; entityId: string; ssoUrl: string }): SAML {
    const existing = this.#clients.get(providerId);
    if (existing !== undefined) {
      return existing;
    }
    const client = new SAML({
      callbackUrl: `${this.configuration.publicOrigin}${AUTH_SAML_CALLBACK_PATH}?providerId=${encodeURIComponent(providerId)}`,
      entryPoint: provider.ssoUrl,
      idpCert: provider.certificatePem,
      idpIssuer: provider.entityId,
      issuer: "singularity-enterprise",
      requestIdExpirationPeriodMs: 5 * 60_000,
      validateInResponseTo: ValidateInResponseTo.always,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
    });
    this.#clients.set(providerId, client);
    return client;
  }
}
