---
name: singularity-simplification-review
description: Use when a Singularity change or audit may contain duplicated state, dead public surface, speculative infrastructure, overlapping upstream/product behavior, or custom machinery that can be removed without losing an accepted user requirement.
---

# Singularity Simplification Review

Simplification is evidence-driven maintenance, not aesthetic code golf. Prefer a few well-proven deletions or ownership consolidations over broad claims that complex-looking code should disappear.

## Start from current decisions

Read `AGENTS.md`, the owning `docs/adr/` decisions, `DIFFS.md`, and the affected implementation. Singularity uses ADRs/plans as its durable decision system; do not create a second Agent Note tree.

Before proposing removal, identify whether the surface is:

- SiYuan-derived behavior that must remain compatible/promotable;
- Singularity-owned enterprise behavior;
- a deliberate architecture/security/lifecycle rule recorded by an ADR;
- generated or compatibility material that should not be judged by ordinary call-site counts.

## Strong candidates

A simplification candidate is strong when evidence shows the current cost exceeds the value, for example:

- a public method, event, config key, helper, adapter, state copy, or registry has no production consumer;
- tests/docs are the only consumers and the behavior is not an accepted compatibility promise;
- two layers represent the same authoritative fact and can use one owner;
- a fallback, queue, lock, cache, retry path, or compatibility shim protects a hypothetical problem rather than an observed/accepted requirement;
- product-owned behavior duplicates a capability now provided adequately by SiYuan upstream;
- custom infrastructure can be replaced by a maintained dependency or platform primitive with net deletion of owned implementation/tests;
- an old ADR/plan describes a superseded implementation and a newer decision already owns the surviving contract.

## Prove or reject

For each candidate:

1. Search exact symbols, routes, configuration keys, event names, persistence fields, and wire/API names.
2. Separate production callers from tests, docs, fixtures, generated outputs, and historical decisions.
3. Name the user capability that would disappear or change.
4. Check `diffs/upstream/registry.yaml` and current upstream capabilities before deleting a local SiYuan divergence.
5. Reject the simplification if it merely relocates complexity, breaks an accepted compatibility/security/lifecycle rule, or turns a cleanup into an unapproved product decision.
6. Prefer deleting speculative surface over adding another compatibility layer when the product has no requirement for it.

## Decision evidence

- Small local cleanup: implement with focused tests/docs; no new ADR required.
- Durable architecture/lifecycle/security/data/upstream policy change: update the owning ADR or create a new ADR that explicitly supersedes the old decision.
- When upstream now owns a capability, retire the corresponding upstream diff record rather than keeping two implementations without a product reason.

## Review output

Record concrete findings in `## Code review`: what can be removed, the production-consumer evidence, what behavior remains, and why the simplification is safe. Do not block accepted work on speculative simplification ideas; defer them when evidence is incomplete.
