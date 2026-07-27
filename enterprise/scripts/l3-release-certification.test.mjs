import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { validateTargetSupervisorReport } from "./l3-release-certification.mjs";

function pendingReport() {
  return {
    status: "pending",
    scope: "target-deployment-supervisor",
    reason: "真实部署证据尚未执行",
    requiredCommand: "pnpm verify:l3-target-supervisor",
    requiredInput: "enterprise/test-results/l3-release-certification/target-supervisor-evidence.json",
    releaseDecision: "blocked-until-target-supervisor-evidence",
  };
}

describe("L3 release certification target supervisor state contract", () => {
  test("accepts the explicit pending marker without certifying the target deployment", () => {
    assert.equal(validateTargetSupervisorReport(pendingReport()), "pending");
  });

  test("accepts passed evidence only after resource cleanup is passed", () => {
    assert.equal(
      validateTargetSupervisorReport({
        evidence: { resourceCleanup: "passed" },
        status: "passed",
      }),
      "passed",
    );
  });

  test("rejects malformed pending and incomplete passed reports", () => {
    const malformedPending = pendingReport();
    malformedPending.releaseDecision = "release";
    assert.throws(() => validateTargetSupervisorReport(malformedPending), /pending 报告的 releaseDecision 不符合合同/);

    assert.throws(
      () => validateTargetSupervisorReport({ evidence: { resourceCleanup: "pending" }, status: "passed" }),
      /未达到 passed\/resourceCleanup=passed/,
    );
    assert.throws(() => validateTargetSupervisorReport({ status: "unknown" }), /status 必须是 passed 或合法 pending/);
  });
});
