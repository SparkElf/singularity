import { DatabaseRuntime } from "@singularity/database";

import { runWorkerApplication } from "./application.js";
import { loadWorkerConfiguration } from "./configuration.js";
import { RestorePlatformModule } from "./restore-platform.module.js";

const abort = new AbortController();
const shutdown = (): void => abort.abort();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  const configuration = loadWorkerConfiguration(process.env);
  const database = new DatabaseRuntime(process.env.DATABASE_URL);
  await runWorkerApplication({
    configuration,
    database,
    restorePlatformModule: RestorePlatformModule.register(
      configuration.restore,
      configuration.deployments,
      database,
    ),
    signal: abort.signal,
  });
} finally {
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
}
