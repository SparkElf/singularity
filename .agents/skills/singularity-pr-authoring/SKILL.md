---
name: singularity-pr-authoring
description: Use before creating or materially rewriting a Singularity pull request. Explain the user result, ownership, upstream impact, UI method, evidence, release truth, and reviewer decision without exposing internal reasoning.
---

# Singularity Pull Request Authoring

A pull request is a review document for someone who did not watch the work happen. A reader should be able to answer these questions before reading the diff:

1. What user or operator problem changes?
2. What can they do differently after merge?
3. Which layer owns the change: SiYuan-derived runtime, Singularity enterprise product, or repository/release governance?
4. What evidence proves the claim?
5. What upstream, migration, security, UI, or release boundary remains?

## Required practice

- Preserve every heading in `.github/PULL_REQUEST_TEMPLATE.md`.
- Lead with observable behavior, not package names or file lists.
- Name exact owners in the architecture section; do not write vague labels such as "core", "UI", or "backend" when a concrete module exists.
- For visible UI, state the reference surface, reused primitives/tokens, real Playwright path, and any remaining native visual acceptance.
- For `app/**` or `kernel/**`, link the active upstream diff record and explain whether the change increases, narrows, or retires divergence.
- For an upstream promotion, include candidate SiYuan tag/SHA, overlapping divergence records, product-overlap review, migration effects, and adopt/rebase/keep/defer decisions.
- Map material claims to the smallest useful evidence: command, CI check, artifact, browser path, or release candidate.
- Label capability truth explicitly: **Available**, **Verified but unreleased**, **Experimental**, **Deferred**, or **Needs maintainer approval**.
- Screenshots explain visible state; they do not prove an interaction, package, release, or deployment exists.
- Do not include hidden reasoning, private prompts, credentials, workspace data, retry diaries, or raw logs that do not help the review decision.

## Authority

Creating a PR, passing CI, or holding repository administration permission does not authorize merge. After the PR is ready, report required-check status and unresolved risks, then wait for explicit maintainer action.
