# Singularity MVP Boundary

Status: accepted for the current MVP phase.

## Product intent

Singularity is built on the SiYuan codebase. Docmost is a product and interaction reference, not a second runtime or a codebase to compose with SiYuan.

The product direction is:

> Keep SiYuan as the single code and content foundation, then manually add the most valuable Docmost-style enterprise knowledge-base capabilities in the smallest form that fits SiYuan.

Do not build a third general-purpose enterprise platform beside SiYuan. Do not duplicate SiYuan capabilities. Do not copy every Docmost or Confluence enterprise feature before the core product loop is proven.

## MVP success path

The MVP is successful when the real product can prove this path end to end:

1. A user can register or sign in.
2. The user can enter an authorized space.
3. The user can create or select a document.
4. The document opens in SiYuan Protyle.
5. The user can edit and save.
6. Reloading shows the persisted content.
7. Another authorized member can read or edit according to a simple role.
8. SiYuan search can find the document.

Work that does not materially improve or protect this path is not automatically part of the MVP.

## Ownership

### SiYuan owns

- Go Kernel and content persistence.
- `.sy` documents, blocks, references, backlinks, search, graph and attribute-view semantics.
- Protyle and native document editing behavior.
- Existing native capabilities that already satisfy the requirement well enough.

### Singularity adds

Only the minimum enterprise product behavior needed around the SiYuan core, such as:

- local user/session authentication;
- organization/space membership when needed for the current user path;
- simple owner/editor/viewer authorization;
- basic invitations or member management;
- minimal sharing or comments only when they enter an accepted MVP user path;
- the smallest bridge needed to expose SiYuan content safely in the web product.

Docmost is used to decide what product behavior is worth adding and how the experience should feel. Its implementation is not a runtime dependency.

## MVP decision filter

Before adding an abstraction, state machine, fallback, queue, cache, retry, registry, security layer, compatibility shim, service, persistence model, CI gate or test suite, answer these questions:

1. Is it required by an accepted MVP user path now?
2. Does SiYuan already provide a sufficient version of the capability?
3. Can the requirement be solved by adapting an existing SiYuan boundary instead of adding a parallel owner?
4. Is there an observed failure or current product requirement behind the defensive machinery?
5. Does the abstraction have at least two real production consumers, or a concrete near-term need that cannot be expressed simply?
6. If the code is deleted, does a current MVP user-visible capability disappear or become unsafe in an ordinary supported deployment?

Default decisions:

- If 1 is no: defer or delete.
- If 2 is yes: reuse SiYuan.
- If 3 is yes: adapt instead of creating another platform layer.
- If 4 is no: do not add speculative defensive machinery.
- If 5 is no: prefer direct code over a new abstraction.
- If 6 is no: prefer deletion.

## Keep in MVP

- SiYuan Kernel and Protyle integration.
- Content directory/document selection required to open real documents.
- Create/read/edit/save/reload.
- SiYuan-backed search needed by the basic knowledge-base experience.
- Local sign-in/session behavior.
- A simple space/member model and simple roles.
- Focused authorization at real external boundaries.
- One real end-to-end test of the primary path.
- Focused unit/integration tests for code changed in the PR.
- Build/typecheck/lint and basic container smoke where they catch ordinary regressions.

## Defer until demanded by product evidence

The following are not MVP requirements merely because a mature enterprise knowledge base may eventually need them:

- SAML, SCIM, MFA and machine API-key platforms;
- multi-IdP and elaborate secret-resolution machinery;
- knowledge-governance lifecycle, approval, classification, legal hold, retention and watermarking;
- enterprise AI governance;
- production realtime-collaboration certification, encrypted collaboration modes and high-session capacity certification;
- release-certification aggregates, supervisor rollback drills and similar pre-production ceremony;
- complex audit intent/finalization/HMAC chains beyond a simple operation log;
- isolated restore-kernel orchestration and advanced backup lifecycle unless the current product cannot rely on simpler SiYuan/runtime backup behavior;
- SBOM/license/vulnerability compliance gates during the MVP phase;
- speculative multi-replica, regional, zero-knowledge or disaster-recovery architecture.

A deferred feature can be reintroduced only with a current user/release requirement and a scoped design that starts from the simplest implementation.

## Simplification rules

- Prefer deletion over a disabled compatibility layer when there is no current contract to preserve.
- Prefer one source of truth and one boundary owner; remove duplicated validation downstream of an already validated boundary.
- Handle invalid external input at the external boundary. Do not repeatedly defend against values that typed/schema-validated internal callers cannot produce.
- Do not keep prototype packages, phase-specific certification runners or historical test scaffolding in the active build merely because they once proved a milestone.
- Do not expand database state machines for future features that are not currently exposed in the MVP.
- Do not turn documentation or old ADR acceptance into a reason to preserve unused complexity. This MVP decision supersedes conflicting scope assumptions from the former L1-L4 expansion plan for the duration of the MVP phase.

## Verification policy

Default MVP pull-request evidence is deliberately small:

1. lint/typecheck for the changed surface;
2. focused unit/integration tests for changed behavior;
3. the primary real E2E path when the change can affect it;
4. basic build/container smoke when deployment wiring changes.

Broader suites are justified only by the changed surface or by a release-specific decision. Passing exhaustive certification is not a product requirement.

## Change governance

Every product or architecture proposal must start by classifying the work as one of:

- `MVP-core`: required for the primary path;
- `MVP-simplification`: deletes or consolidates unnecessary machinery;
- `deferred`: useful later but not required now;
- `rejected`: duplicates SiYuan or adds speculative complexity without evidence.

For the MVP phase, this document is the product-scope authority. If an older plan, handoff, ADR interpretation or verification document conflicts with this boundary, follow this boundary and update/supersede the older material when it is touched.
