---
name: singularity-implementation
description: Use after an accepted Singularity product and architecture plan. Implement the complete user path while preserving explicit ownership, upstream traceability, and release truth.
---

# Implementation for Singularity

Implement the accepted user path in the owning modules. Keep upstream-derived modifications narrow and Singularity-owned enterprise behavior explicit.

## Required practice

- Reuse existing SiYuan extension points, Singularity APIs, enterprise packages, and UI primitives before adding new owners.
- Keep one authoritative state owner; do not copy persistent or UI state across modules for convenience.
- Update configuration, data migration, user-visible failure/recovery behavior, docs, tests, and governance metadata in the same change when they are part of the feature.
- Update the relevant diff record whenever a maintained upstream or product divergence changes.
- For visible UI, follow `singularity-frontend-design` and `docs/ui-governance.md`.
- Do not commit credentials, production data, private workspace content, hidden prompts, or secrets in fixtures/logs/screenshots.
- Do not label incomplete or unverified behavior as released, production-ready, or supported.
- When upstream SiYuan has gained equivalent behavior, do not automatically preserve the local implementation; route the decision through upstream promotion and divergence retirement review.

Record implemented scope and deliberate exclusions in the pull request under `## Implementation`.
