import "reflect-metadata";

import { parseAuditConfiguration } from "@singularity/database";

import { runAccessOperationsApplication } from "./application.js";

process.exitCode = await runAccessOperationsApplication({
  auditConfiguration: parseAuditConfiguration(process.env),
  databaseUrl: process.env.DATABASE_URL,
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
});
