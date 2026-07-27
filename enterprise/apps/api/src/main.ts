import { parseAuditConfiguration } from "@singularity/database";

import { createApiApplication } from "./application.js";
import { parseBooleanFlag } from "./configuration.js";
import {
  IdentityProvisioningService,
} from "./identity/identity-provisioning.service.js";
import { loadKernelGatewayConfiguration } from "./kernel/configuration.js";

const app = await createApiApplication({
  auditConfiguration: parseAuditConfiguration(process.env),
  contentAuditIndeterminateAfterMilliseconds:
    process.env.SINGULARITY_CONTENT_AUDIT_INDETERMINATE_AFTER_MS,
  databaseUrl: process.env.DATABASE_URL,
  kernelGateway: loadKernelGatewayConfiguration(process.env),
  oidcClientSecretBindings:
    process.env.SINGULARITY_OIDC_CLIENT_SECRET_BINDINGS,
  publicOrigin: process.env.SINGULARITY_PUBLIC_ORIGIN,
  trustedProxyCidrs: process.env.SINGULARITY_TRUSTED_PROXY_CIDRS,
});

app.enableShutdownHooks();

if (parseBooleanFlag(process.env.SINGULARITY_INITIAL_ADMIN_BOOTSTRAP, true)) {
  const initialAdmin = await app
    .get(IdentityProvisioningService)
    .ensureInitialInstallation();
  if (initialAdmin.created) {
    // 初次部署只输出一次随机密码，便于运维安全接管；后续重启不会重新生成或覆盖它。
    process.stderr.write(
      `${JSON.stringify({
        event: "identity.initial-admin-created",
        loginIdentifier: initialAdmin.loginIdentifier,
        password: initialAdmin.password,
        warning: "Store this password securely; it is shown only on first deployment.",
      })}\n`,
    );
  }
}

await app.listen(Number(process.env.PORT ?? 3001), "0.0.0.0");
