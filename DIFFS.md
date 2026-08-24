# Singularity Diff Protocol

Singularity is maintained as an independent product repository built on SiYuan. GitHub fork metadata is not used as the source of truth for upstream relationship.

## Registries

| Registry | Owns |
| --- | --- |
| `diffs/upstream/registry.yaml` | Maintained changes to SiYuan-derived behavior and files. |
| `diffs/product/registry.yaml` | Singularity-owned enterprise capabilities, repository governance, distribution, and product-only integrations. |
| `upstream/baseline.yaml` | Exact SiYuan version and commit currently promoted into Singularity. |

Each record has a stable ID, status, capability, ownership, affected paths, compatibility statement, and verification evidence. Upstream records also name the SiYuan baseline they diverge from.

## Status

- `planned`: accepted work that has not changed shipped behavior.
- `active`: maintained Singularity behavior that exists in the source/product.
- `retired`: behavior removed locally or replaced by an upstream/product owner. The record remains for history.

## Upstream promotions

An upstream promotion is a reviewed product change, not a blind merge. A promotion candidate must:

1. identify the exact new SiYuan tag/commit;
2. compare it with the pinned baseline;
3. find overlap with every active upstream divergence;
4. detect upstream capabilities that may replace Singularity product implementations;
5. classify conflicts as keep-local, adapt, retire, or defer;
6. run the full selected governance/build/integration/e2e evidence;
7. update `upstream/baseline.yaml` only when the promotion is accepted.

Automation may discover and prepare candidates. It must not automatically merge a candidate into the canonical branch.

## Bootstrap note

The first registry is intentionally path-grouped because the existing fork accumulated a large set of changes before this protocol existed. Future changes should split records by stable capability rather than expanding broad bootstrap records indefinitely.
