---
name: singularity-test-governance
description: Use when planning or changing Singularity behavior. Select the smallest evidence set that proves the real user/operator result across upstream, enterprise, browser, persistence, and release boundaries.
---

# Test Governance for Singularity

Test what users and operators rely on. Match evidence to the changed surface; do not replace user-path evidence with static source checks or screenshots.

## Evidence selection

- A `kernel/**` behavior change needs focused Go regression coverage and, when it changes a visible workflow, integration or browser evidence through the real API path.
- An `app/**` change needs the existing SiYuan lint/type checks plus focused behavior evidence for the changed native UI or API integration.
- An enterprise API or persistence change needs focused tests with the real schema/database boundary where persistence behavior matters.
- An enterprise browser workflow needs Playwright through the actual visible path and real application services suitable for CI.
- A permission, identity, sharing, or collaboration change needs positive and negative authorization evidence at the owning boundary.
- A UI change needs functional interaction evidence plus light/dark and keyboard/focus verification for the changed path; screenshots are secondary.
- An upstream baseline promotion requires full governance, build, focused divergence checks, and the broad integration/e2e set selected by the impact planner.
- Documentation-only changes run documentation/governance gates without unrelated product suites.

## Prohibited substitutions

Do not treat any of the following as sufficient proof of a user workflow by itself: source-string assertions, mock-only tests, syntax checks, a component render without interaction, a screenshot, or a build that never operates the feature.

Record selected commands, why they match the risk, and expected user/operator evidence in the pull request under `## Test governance`.
