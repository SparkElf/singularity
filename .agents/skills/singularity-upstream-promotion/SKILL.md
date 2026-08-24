---
name: singularity-upstream-promotion
description: Use when evaluating or integrating a newer SiYuan release/commit. Prepare a controlled promotion candidate, classify divergence impact, verify it, and never auto-merge upstream into the canonical branch.
---

# Controlled SiYuan Upstream Promotion

An upstream promotion is a Singularity product change. Do not merge or rebase SiYuan `master` directly into the canonical branch as routine maintenance.

## Inputs

- current source of truth: `upstream/baseline.yaml`;
- candidate SiYuan tag and exact commit;
- `diffs/upstream/registry.yaml` active records;
- `diffs/product/registry.yaml` active capabilities;
- upstream release notes and changed paths.

## Procedure

1. Fetch the candidate upstream commit read-only and verify the tag resolves to the expected SHA.
2. Produce a baseline-to-candidate change report grouped by kernel, native app/editor, AI/MCP/search, packaging, dependency, migration, security, and documentation surfaces.
3. Intersect changed upstream paths with every active upstream divergence record.
4. Compare upstream release capabilities with active Singularity product capabilities. Flag possible replacement/overlap even when Git reports no textual conflict.
5. For every impacted divergence classify one action:
   - `adopt-upstream`: local behavior can retire;
   - `rebase-local`: local behavior remains but is adapted to the candidate;
   - `keep-local`: no implementation change is needed but verification is required;
   - `defer`: candidate cannot yet be promoted safely.
6. Create a candidate branch named `upstream/siyuan-<version>` from Singularity canonical history. Integrate the candidate there, never directly on the canonical branch.
7. Update diff record statuses/paths/compatibility as part of the candidate. Update `upstream/baseline.yaml` only in the promotion change, not in an impact-only report.
8. Run governance plus the full CI lanes selected for baseline changes, including native app, enterprise integration, persistence, browser E2E, and build/package evidence.
9. Open one promotion PR containing the candidate SHA, capability-impact table, conflict decisions, retired divergences, verification evidence, migration notes, and residual risk.
10. Stop after the PR is ready. Promotion, merge, tag, release, and deployment require explicit maintainer approval.

## Automation boundary

Scheduled automation may discover releases, calculate impact, create/update reports, and prepare a candidate branch/PR. It must never silently move the canonical baseline or merge the promotion.
