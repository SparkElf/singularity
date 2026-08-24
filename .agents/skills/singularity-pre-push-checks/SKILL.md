---
name: singularity-pre-push-checks
description: Use before pushing, rewriting, or claiming a Singularity candidate branch is ready. Select the smallest credible evidence from the outgoing diff while leaving exhaustive matrices to CI.
---

# Singularity Pre-Push Checks

Validate the change that is actually leaving the workstation or agent branch. Do not reflexively run every repository suite: CI owns exhaustive and platform-wide coverage, while local/pre-push evidence should be the smallest set that would catch the regression the diff can create.

## Resolve the outgoing scope

1. Confirm repository and branch; never infer that `master` is canonical. Singularity canonical is `main`, while SiYuan upstream is `upstream/master`.
2. Fetch the verified PR base or `origin/main`.
3. Inspect the complete diff and run the repository impact planner:

```sh
git status --short --branch
git fetch origin main
node scripts/singularity/resolve-ci-impact.mjs --base origin/main --head HEAD --json
```

Use the real PR base instead of `origin/main` when the review topology says otherwise. Re-run impact planning after rebases/merges that change the base.

## Select evidence

- **Governance/docs only:** run the relevant governance/script tests and document/link checks; do not start PostgreSQL or Playwright without a changed user/runtime path.
- **Enterprise Web:** run owning lint/type/unit/build checks plus the focused browser/Playwright path for visible behavior.
- **Enterprise API/Worker/shared contracts:** run owning static/unit/integration checks and the smallest end-to-end path affected by the contract.
- **`app/**`:** run SiYuan-native lint/tests plus the bridge/browser path affected by the change; update `diffs/upstream/registry.yaml` in the same change.
- **`kernel/**`:** run focused Go tests plus affected integration/E2E/package evidence; update upstream divergence metadata.
- **Baseline promotion, release candidate, or unclassified cross-cutting change:** run the broader/full set selected by governance. These are deliberate exceptions to narrow local validation.

A screenshot, source-string assertion, or successful build is not a substitute for operating a changed user path. Conversely, do not repeat an unrelated passing full suite merely for ceremony.

## Push and history safety

- Work on candidate/feature branches; do not push product changes directly to canonical `main` after bootstrap closeout.
- Normal history pushes normally.
- An authorized history rewrite uses `--force-with-lease` against the exact observed remote OID. Raw `--force` is not allowed.
- After a rewrite, treat old approvals, inline anchors, and commit checks as stale until the live branch is re-read.
- A successful push does not authorize merge, release, upstream promotion, or deployment.

## Failure handling

If selected evidence fails, fix it or report the exact blocker before claiming readiness. If a failure is environment-specific, prove the environment mismatch and keep the affected verification explicitly pending; do not weaken a gate to make the branch green.

Record only commands actually run and their outcomes in the PR `## Test governance` / `## Verification` sections.
