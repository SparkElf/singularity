import { createApiApplication } from "./application.js";

const app = await createApiApplication({
  databaseUrl: process.env.DATABASE_URL,
});

app.enableShutdownHooks();

await app.listen(Number(process.env.PORT ?? 3001), "0.0.0.0");
