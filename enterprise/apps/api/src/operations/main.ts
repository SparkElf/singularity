import "reflect-metadata";

import { runAccessOperationsApplication } from "./application.js";
import { parseAuditConfiguration } from "../configuration.js";

process.exitCode = await runAccessOperationsApplication({
  auditConfiguration: parseAuditConfiguration(process.env),
  databaseUrl: process.env.DATABASE_URL,
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
});
