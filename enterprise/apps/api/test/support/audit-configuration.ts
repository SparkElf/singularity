import { createSecretKey } from "node:crypto";

import type { AuditConfiguration } from "@singularity/database";

export function testAuditConfiguration(): AuditConfiguration {
  return {
    hmacKey: createSecretKey(Buffer.alloc(32, 0x53)),
    keyVersion: "test-v1",
  };
}
