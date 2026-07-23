import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { validateEvidence } from "./l3-target-supervisor-evidence.mjs";

const processRecord = (role, pid, ppid) => ({
  command: `/opt/singularity/${role}`,
  pid,
  ppid,
  role,
});

function validEvidence() {
  const stage = (revision, supervisorId, pidOffset) => ({
    health: { api: "passed", kernel: "passed", worker: "passed" },
    processOwnership: "passed",
    processes: [
      processRecord("kernel", 100 + pidOffset, 10 + pidOffset),
      processRecord("api", 200 + pidOffset, 10 + pidOffset),
      processRecord("worker", 300 + pidOffset, 10 + pidOffset),
    ],
    resourceCleanup: "passed",
    revision,
    supervisorId,
  });
  return {
    approved: stage("approved-revision", "supervisor-approved", 1),
    candidate: stage("candidate-revision", "supervisor-candidate", 2),
    completedAt: "2026-07-23T01:00:00.000Z",
    deploymentId: "deployment-1",
    operator: "release-operator",
    resourceCleanup: "passed",
    schemaVersion: 1,
    startedAt: "2026-07-23T00:00:00.000Z",
    status: "passed",
    switch: {
      candidateStopped: "passed",
      oldProcessesGone: "passed",
      sharedPortsReused: "passed",
    },
  };
}

describe("L3 target supervisor evidence gate", () => {
  test("accepts complete three-process deployment observations", () => {
    const result = validateEvidence(validEvidence());
    assert.equal(result.status, "passed");
    assert.deepEqual(result.candidate.processes.map((process) => process.role), ["kernel", "api", "worker"]);
    assert.equal(result.switch.oldProcessesGone, "passed");
  });

  test("rejects evidence that omits process ownership or reuses a revision", () => {
    const missingOwnership = validEvidence();
    missingOwnership.candidate.processOwnership = "pending";
    assert.throws(() => validateEvidence(missingOwnership), /candidate processOwnership must be passed/);

    const sameRevision = validEvidence();
    sameRevision.approved.revision = sameRevision.candidate.revision;
    assert.throws(() => validateEvidence(sameRevision), /revisions must differ/);
  });
});
