import { runAccessOperationsApplication } from "./application.js";

process.exitCode = await runAccessOperationsApplication({
  databaseUrl: process.env.DATABASE_URL,
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
});
