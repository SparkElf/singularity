---
name: singularity-code-review
description: Use after implementation and before verification for non-mechanical Singularity changes. Review user regressions, ownership, upstream divergence, data/security boundaries, UI consistency, and release truth.
---

# Code Review for Singularity

Review the change as a user, operator, upstream maintainer, and enterprise product maintainer. Lead with concrete findings; a changed file or passing syntax check is not product evidence.

## Review checks

- Does the change deliver the stated user result and preserve the stated recovery path?
- Is every state transition, credential, permission, durable record, and external side effect owned by one clear module?
- Are changes under SiYuan-derived surfaces narrow, documented in `diffs/upstream/registry.yaml`, and compatible with the pinned upstream baseline?
- Are Singularity-owned enterprise changes documented in `diffs/product/registry.yaml` when they form a maintained product divergence?
- If upstream now provides equivalent behavior, has the review considered retiring rather than duplicating the local implementation?
- For visible UI, does the change reuse semantic tokens and interaction primitives, preserve light/dark and keyboard/focus behavior, and avoid a parallel style system?
- Do docs, UI copy, README, release notes, and availability claims match the behavior that is actually implemented and verified?
- Are tests proving user/operator behavior rather than only internal implementation details?
- Is the implementation simpler and more maintainable than the reasonable alternatives?
- Are credentials, private content, model prompts, and production data absent from source, fixtures, logs, and screenshots?

Record findings, fixes, and residual concerns in the pull request under `## Code review`. Final approval remains a maintainer decision.
