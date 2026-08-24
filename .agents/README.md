# Singularity Agent Workflow

Singularity is an independent product built on SiYuan. AI-assisted changes follow an explicit product-to-verification path so repository growth does not create hidden product, architecture, UI, or upstream drift.

## Required sequence

For non-mechanical changes, use the repository skills in this order:

1. `singularity-product-design` — define the user result and release claim.
2. `singularity-architecture-planning` — define ownership, boundaries, upstream impact, persistence, permissions, and evidence.
3. `singularity-frontend-design` — required for visible UI changes; reuse the current token and primitive system instead of inventing a parallel style language.
4. `singularity-implementation` — implement only the accepted scope and update governance metadata in the same change.
5. `singularity-code-review` — review regressions, ownership, upstream drift, UI consistency, and release claims.
6. `singularity-test-governance` — select evidence that proves the real user path.
7. `singularity-verification` — re-run the selected evidence after review fixes and verify the built result.

Use `singularity-maintain-diffs` whenever a change touches SiYuan-derived code, product-owned enterprise code, upstream baseline metadata, or an upstream promotion.

## Authority

AI agents may prepare branches, commits, tests, documentation, and pull requests when requested. A passing CI run does not authorize merge, release, upstream promotion, or production deployment. Those decisions remain explicit maintainer actions.

## Repository identity

GitHub fork metadata is not the upstream tracking mechanism. The canonical repository is intended to be a non-fork repository with SiYuan tracked through `upstream/baseline.yaml`, `diffs/`, and controlled promotion pull requests.
