# Singularity Agent Workflow

Singularity is an independent product built on SiYuan. During the MVP phase, `docs/product/mvp-boundary.md` is the product-scope authority.

Docmost is a product and interaction reference, not a second runtime or a codebase to compose with SiYuan. Keep SiYuan as the single code/content foundation and manually add only the smallest Docmost-style capabilities needed by current user paths.

## MVP gate comes first

Before using any design or architecture skill, classify the requested work as:

- `MVP-core` — required by the primary product path;
- `MVP-simplification` — deletes/consolidates unnecessary machinery;
- `deferred` — useful later but not needed now;
- `rejected` — duplicates SiYuan or introduces speculative complexity without evidence.

If the work is `deferred` or `rejected`, do not implement infrastructure for it.

## Default sequence

Use the smallest process that proves the user result:

1. Apply `docs/product/mvp-boundary.md` and state the current user-visible result.
2. For cleanup or consolidation, use `singularity-simplification-review` before proposing new abstractions.
3. Use `singularity-product-design` only when product behavior is genuinely undecided.
4. Use `singularity-architecture-planning` only for a real durable boundary, persistence, security, or ownership decision.
5. Use `singularity-frontend-design` when a visible change needs design-system decisions; ordinary reuse of existing primitives does not require a separate design phase.
6. Use `singularity-implementation` for the minimum accepted scope.
7. Use `singularity-code-review`, focused `singularity-test-governance`, and `singularity-verification` only to the extent needed to prove the changed surface.

Do not reflexively run every historical L1-L4 test/certification suite. Do not preserve prototype packages, phase-specific certification runners, defensive state machines, compatibility shims or generalized infrastructure solely because an older plan once accepted them.

Use `singularity-maintain-diffs` when SiYuan-derived code or upstream baseline metadata actually changes. Use `singularity-upstream-promotion` for a SiYuan baseline promotion and `singularity-pre-push-checks` for outgoing branch evidence.

## Simplification bias

Prefer deletion when a public surface, fallback, queue, lock, cache, retry path, state copy, registry, adapter or compatibility shim has no current MVP production requirement. Handle invalid input once at the real external boundary and avoid repeated downstream guards for impossible typed/schema-validated states.

If SiYuan already owns the capability, adapt or reuse it instead of creating a product-owned duplicate. A new abstraction normally needs at least two real production consumers or a concrete immediate need.

## Durable decisions

`docs/product/mvp-boundary.md` owns current MVP scope. `docs/adr/` records durable architecture decisions and `plans/` owns scoped execution plans. Older ADRs and plans remain historical evidence, but their former scope assumptions do not override the current MVP boundary.

A new or superseding ADR is required only when a durable architecture, lifecycle, security, data, UI-system, release, or upstream-maintenance rule genuinely changes. Ordinary deletion and local simplification do not need additional architectural ceremony.

## Authority

AI agents may prepare branches, commits, tests, documentation, and pull requests when requested. A passing CI run does not authorize merge, release, upstream promotion, or production deployment. Those decisions remain explicit maintainer actions.

## Repository identity

GitHub fork metadata is not the upstream tracking mechanism. The canonical `SparkElf/singularity` repository is an independent non-fork repository with canonical branch `main`; SiYuan is tracked through `upstream/baseline.yaml`, `diffs/`, and controlled promotion pull requests against upstream `master`.
