---
name: singularity-verification
description: Use after review and before merge, upstream promotion, or release. Verify Singularity against accepted user results, governance metadata, built artifacts, and deployment boundaries.
---

# Verification for Singularity

Verify promises, not file counts.

## Required checks

- Re-run the exact evidence selected by test governance after review fixes.
- Confirm `upstream/baseline.yaml` and active diff records match the committed implementation.
- Confirm product, architecture, frontend-design, implementation, review, test-governance, and verification claims in the PR describe current code rather than an earlier iteration.
- For visible UI, operate the actual workflow at the supported viewport(s), inspect console/network failures, and check relevant light/dark and keyboard/focus states.
- For persistence or migration changes, verify upgrade, failure behavior, and rollback/recovery evidence appropriate to the accepted deployment contract.
- For upstream promotions, confirm the candidate baseline is exact, every conflict/local divergence is classified, retired records are updated, and full selected CI passes before promotion approval.
- Before publishing, verify the built artifact/container from a clean checkout, its metadata/checksum/SBOM when configured, and release notes against the artifact actually produced.
- Do not treat a passing PR as authorization to merge, tag, release, deploy, or promote upstream. Those are explicit maintainer decisions.

Record passing evidence and residual risk in the pull request under `## Verification`.
