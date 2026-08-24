---
name: singularity-maintain-diffs
description: Use whenever Singularity changes SiYuan-derived code, product-owned enterprise behavior, the pinned upstream baseline, or a maintained local divergence.
---

# Maintain Singularity Diff Records

Singularity tracks upstream relationship explicitly instead of relying on GitHub fork metadata.

## Registries

- `diffs/upstream/registry.yaml` records maintained changes to SiYuan-derived behavior or files.
- `diffs/product/registry.yaml` records Singularity-owned enterprise/product capabilities whose lifecycle must remain explicit across releases and upstream promotions.
- `upstream/baseline.yaml` records the exact SiYuan source baseline currently promoted into Singularity.

## Procedure

1. Classify the change as `upstream`, `product`, or both.
2. Create/update a stable record with status, user-facing capability, source/baseline, affected paths, ownership, compatibility statement, and verification.
3. Use `planned` only for accepted work not yet changing shipped behavior, `active` for maintained local behavior, and `retired` when behavior was removed or replaced by upstream/product architecture.
4. Never use line numbers as durable metadata; paths, owners, baseline SHAs, feature IDs, and verification commands are the maintained facts.
5. During an upstream promotion, inspect every active upstream record whose paths overlap upstream changes and every product record whose capability is newly provided upstream.
6. Retire rather than duplicate when the promoted upstream implementation satisfies the accepted Singularity requirement.
7. Keep retirement history in Git and the registry status; do not delete the record merely because the divergence disappeared.
8. Run the repository governance verifier before review once it is available in the new independent repository.

A pull request that changes a divergence without updating its record is incomplete.
