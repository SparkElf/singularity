import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

import { singleHeader, type HttpRequestBoundary } from "../http-boundary.js";
import { unauthenticated } from "../problem.js";
import { EnterpriseGovernanceService } from "./governance.service.js";

interface ScimRequest extends HttpRequestBoundary {
  readonly params: { readonly organizationId?: unknown };
}

/** 在进入 SCIM controller 前统一完成 Bearer 摘要校验和组织作用域绑定。 */
@Injectable()
export class ScimTokenGuard implements CanActivate {
  constructor(private readonly governance: EnterpriseGovernanceService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ScimRequest>();
    const authorization = singleHeader(request.headers.authorization);
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    if (token === undefined || token.length === 0) {
      throw unauthenticated();
    }
    const identity = await this.governance.authenticateScimToken(token);
    if (identity.organizationId !== request.params.organizationId) {
      throw unauthenticated();
    }
    return true;
  }
}
