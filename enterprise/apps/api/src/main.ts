import { createApiApplication } from "./application.js";

const app = await createApiApplication({
  databaseUrl: process.env.DATABASE_URL,
  publicOrigin: process.env.SINGULARITY_PUBLIC_ORIGIN,
  trustedProxyCidrs: process.env.SINGULARITY_TRUSTED_PROXY_CIDRS,
});

app.enableShutdownHooks();

await app.listen(Number(process.env.PORT ?? 3001), "0.0.0.0");
