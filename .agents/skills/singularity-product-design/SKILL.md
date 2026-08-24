---
name: singularity-product-design
description: Use before changing a Singularity user workflow, enterprise capability, upstream-derived behavior, deployment promise, or release claim.
---

# Product Design for Singularity

Start from the person using or operating the knowledge base, not from repository structure.

## Required output

- Name the primary user and the immediate task they are trying to finish.
- Describe the current behavior and the observable result the change must produce.
- Separate **available now**, **in development**, **deferred**, and **requires maintainer approval**. Never describe planned work as shipped.
- Define the shortest successful path, failure feedback, recovery path, and data or credential expectations.
- Write acceptance criteria as user-visible or operator-visible results rather than file changes.
- For enterprise features, identify tenant/organization/space scope and the data owner.
- For AI features, identify what content may be sent to a model, the credential owner, permissions, audit expectations, and fallback when AI is unavailable.
- For upstream-derived behavior, state whether the desired result belongs in Singularity, should be proposed upstream, or should remain a local divergence.

Record the decision in the pull request under `## Product design` before implementation begins.
