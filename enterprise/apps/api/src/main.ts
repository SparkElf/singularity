import { parseAuditConfiguration } from "@singularity/database";

import { createApiApplication } from "./application.js";
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

await app.listen(Number(process.env.PORT ?? 3001), "0.0.0.0");
