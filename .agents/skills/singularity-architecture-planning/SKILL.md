---
name: singularity-architecture-planning
description: Use after product design and before non-mechanical Singularity code changes to define ownership, boundaries, upstream impact, permissions, persistence, and verification.
---

# Architecture Planning for Singularity

Plan the complete path from user action to durable result. Keep SiYuan-derived runtime behavior, Singularity enterprise behavior, and integration boundaries explicit.

## Required output

- List the owning modules, UI surfaces, APIs, configuration, persistence, background work, and external systems.
- Name one owner for every state transition, credential, privileged operation, durable record, and cache.
- State whether each changed file is upstream-derived (`app/**`, `kernel/**`, other imported SiYuan surfaces) or Singularity-owned (`enterprise/**`, product governance, deployment, product-only integrations).
- Add or update the relevant `diffs/upstream/registry.yaml` or `diffs/product/registry.yaml` entry before implementation when the change creates or alters a maintained divergence.
- Identify the currently pinned SiYuan baseline and whether the design depends on behavior newer than that baseline.
- Prefer stable SiYuan extension points and narrow adapters over broad patches to upstream-owned modules.
- Define migration and rollback behavior for persisted data or deployment changes.
- Define the smallest credible unit, integration, browser, and release evidence for the user path.

## Scope discipline

Do not add queues, locks, compatibility shims, fallback systems, duplicated state, or speculative abstraction without an accepted user or operational requirement. When an upstream capability can replace a local implementation, prefer a retirement plan over maintaining two owners.

Record the architecture in the pull request under `## Architecture`.
