# AGENTS.md

Singularity is an independent enterprise knowledge-base product built on the SiYuan codebase. The canonical repository is `SparkElf/singularity`, it is a **non-fork GitHub repository**, and its canonical branch is `main`. SiYuan remains the explicit upstream at `siyuan-note/siyuan:master`, tracked through `upstream/baseline.yaml`, `diffs/`, and controlled promotion pull requests.

## 0. MVP authority

During the current MVP phase, read `docs/product/mvp-boundary.md` first. It is the product-scope authority and supersedes conflicting scope assumptions in older L1-L4 plans, handoffs, ADR interpretations, verification records, or enterprise-roadmap documents.

The core product rule is:

> Keep SiYuan as the single code and content foundation. Use Docmost as a product/interaction reference and manually add only the smallest Docmost-style capabilities needed for the current MVP.

Before adding code, classify the change as `MVP-core`, `MVP-simplification`, `deferred`, or `rejected`. If a feature is not required by a current MVP user path, do not implement infrastructure for it merely because a mature enterprise product may need it later.

Prefer deletion of speculative machinery over preservation for hypothetical future compatibility. Prefer existing SiYuan capabilities over parallel product-owned implementations. Handle invalid input at the real external boundary instead of adding repeated internal guards for values that typed/schema-validated callers cannot produce.

Before non-mechanical work, read:

1. `docs/product/mvp-boundary.md` — current product scope and simplification authority.
2. `.agents/README.md` — AI engineering sequence and authority.
3. `DIFFS.md` — upstream/product divergence protocol when the change actually touches maintained divergence.
4. `upstream/baseline.yaml` — exact promoted SiYuan baseline when upstream-derived code matters.
5. `docs/ui-governance.md` — UI ownership rules for visible changes.
6. The owning ADR only when the change reaches an established durable architecture/lifecycle/security rule.
7. The relevant skill under `.agents/skills/` when it materially helps the change.

## 1. MVP-first engineering sequence

Do not run a seven-stage design ceremony for every non-mechanical change. Use the smallest process that proves the user result.

Default sequence:

1. Apply the MVP filter from `docs/product/mvp-boundary.md` and state the current user result.
2. Use `singularity-simplification-review` first when the work is cleanup, consolidation, removal of speculative machinery, or ownership reduction.
3. Use `singularity-product-design` only when product behavior or user-visible scope is genuinely undecided.
4. Use `singularity-architecture-planning` only when a durable boundary, persistence model, security model, or cross-module ownership decision is actually being introduced or changed.
5. Use `singularity-frontend-design` for visible UI changes that need design-system decisions; ordinary reuse of existing components does not require a new design exercise.
6. Implement the minimum accepted scope.
7. Review and run focused evidence for the changed surface. Use `singularity-test-governance` / `singularity-verification` when they add value; do not reflexively run unrelated exhaustive suites.

Use `singularity-maintain-diffs` when SiYuan-derived code or the upstream baseline actually changes. Use `singularity-upstream-promotion` for a SiYuan version/commit promotion and `singularity-pre-push-checks` for outgoing branch evidence.

A passing CI run does not authorize merge, upstream promotion, release, or deployment. Those require an explicit maintainer decision.

## 2. Architecture and ownership

Singularity has three important code ownership planes:

| Plane | Paths | Owner |
| --- | --- | --- |
| SiYuan native runtime | `kernel/**`, `app/**` | Upstream-derived. Keep local changes narrow and promotable. |
| Singularity enterprise platform | `enterprise/**`, `config/**` | Product-owned additions needed around the SiYuan core. Keep this layer as small as the accepted product path allows. |
| Repository/product governance | `.agents/**`, `.github/**`, `diffs/**`, `upstream/**`, `scripts/singularity/**`, product docs/release assets | Singularity-owned. Governance must not become a product in itself. |

The Go kernel remains the native content/data engine. The SiYuan TypeScript frontend remains the native workspace/editor owner. Enterprise React UI is mounted as a Singularity-owned product surface; do not create a second owner for native document/editor state.

Docmost is a product and interaction reference. Do not introduce Docmost as a runtime dependency or build a parallel Docmost control plane. Reimplement only the desired capability in the smallest form that fits SiYuan.

### Core SiYuan layout

- `kernel/`: Go backend, API, content trees, SQLite/indexing, sync, AI/MCP, server, mobile bindings.
- `app/`: SiYuan native TypeScript/Electron/web UI and Protyle editor.
- `app/stage/`: build/runtime assets; many generated artifacts are not hand-edited.

### Enterprise layout

- `enterprise/apps/web/`: React/Vite enterprise UI and focused browser evidence.
- `enterprise/apps/api/`: minimum enterprise API/control-plane behavior required by current paths.
- `enterprise/apps/worker/`: background work only where a current product path requires asynchronous execution.
- `enterprise/packages/`: shared packages that have real production consumers; do not keep prototype or single-consumer abstractions by default.

## 3. Upstream policy

- Canonical repository/branch: `SparkElf/singularity:main`.
- Upstream repository/branch: `siyuan-note/siyuan:master`.
- The exact promoted version/commit lives in `upstream/baseline.yaml` plus compatibility metadata required by existing build tooling.
- Never treat GitHub fork metadata as the upstream tracking mechanism.
- Never automatically merge SiYuan `master` into canonical `main`.
- Upstream automation may discover, compare, report, and prepare a candidate branch/PR; it must not silently move the canonical baseline.
- A promotion candidate is named `upstream/siyuan-<version>` and must classify every impacted active divergence as adopt-upstream, rebase-local, keep-local, or defer.
- If upstream now satisfies a local capability, prefer retiring the local divergence over maintaining two implementations.

## 4. Diff governance

`diffs/upstream/registry.yaml` records maintained SiYuan-derived divergences. `diffs/product/registry.yaml` records Singularity-owned product capabilities whose lifecycle matters across releases/upstream promotions.

Do not create or expand registry records merely to justify speculative product machinery. A record uses a stable ID and one of `planned`, `active`, or `retired`. Retire records when the associated product capability is removed during MVP simplification.

Any PR changing `app/**` or `kernel/**` must update `diffs/upstream/registry.yaml` in the same PR. Baseline changes also update upstream diff metadata.

## 5. UI engineering rules

Visible UI work should reuse the existing design system and current user path before adding new states or primitives.

### Enterprise React UI

- `enterprise/apps/web/src/styles.css` is the current semantic theme owner.
- `enterprise/apps/web/src/components/ui/` owns reusable React interaction primitives.
- Feature packages consume those owners; they do not create another global theme, icon system, spacing scale, or component library.
- Light and dark themes share geometry, hierarchy, and interaction; theme branches change semantic values, not component structure.
- Implement loading, empty, failure/recovery, permission, disabled, focus/keyboard, success, long-content, and overflow states when they belong to an accepted user path. Do not manufacture exhaustive theoretical state matrices for unreachable or deferred flows.
- Screenshots are visual evidence only. Playwright or the applicable browser flow should operate the real user path when browser evidence is needed.

### SiYuan native UI

- Reuse neighboring native SiYuan components and `--b3-*` semantic variables.
- Do not transplant enterprise-only visual primitives into `app/**` to solve a local styling problem.
- Because `app/**` is upstream-derived, native UI changes require an upstream diff record and promotion-aware review.

## 6. Toolchain and verification

Read versions from source-of-truth files:

| Tool | Source |
| --- | --- |
| Go | `kernel/go.mod` |
| Node | CI workflows; current governance baseline uses Node 24 |
| pnpm (enterprise) | `enterprise/package.json` |
| pnpm (SiYuan app) | `app/package.json` |

Default MVP evidence is intentionally small:

```sh
# run only the applicable changed-surface lint/typecheck/tests
# run the primary real E2E path when the change can affect it
# run build/container smoke when deployment wiring changes
```

`pnpm verify:b4`, `pnpm verify:s0-s3`, historical L3/L4 certification aggregates, or similarly broad suites are not automatic MVP requirements. Use only evidence justified by the changed surface or an explicit release decision.

Use `singularity-pre-push-checks` and `singularity-test-governance` to select evidence from the changed surface; do not run unrelated exhaustive suites merely for ceremony.

## 7. Do not hand-edit

- `app/stage/protyle/js/lute/lute.min.js` (generated from upstream Lute)
- `app/stage/build/**`
- `app/src/types/dist/**`
- `app/changelogs/**` when generated by release tooling
- `app/kernel/SiYuan-Kernel*`
- `kernel/kernel.aar`
- generated platform binaries and bundled Pandoc assets

Use source repositories/generators for generated artifacts.

## 8. SiYuan-specific conventions

- New i18n keys must be added consistently across the applicable language files; do not copy untranslated text across locales.
- After i18n changes run `python scripts/check-lang-keys.py` when the changed surface uses the SiYuan language bundle.
- Prefer Node.js or Python for cross-platform repository scripts; use platform-specific shell only when the platform contract requires it.
- For frontend verification, prefer the documented app lint/test path. Do not use ad-hoc build commands that conflict with the developer runtime.
- Reuse existing icons rather than hand-writing new SVG artwork for routine controls.
- Go changes are formatted with `gofmt`.

## 9. Decisions, coding, and documentation

- `docs/product/mvp-boundary.md` owns current MVP scope.
- `docs/adr/` records durable architecture decisions; `plans/` owns scoped execution plans. Historical acceptance does not force preservation of code that the current MVP explicitly defers or removes.
- Add or supersede an ADR only when a durable architecture/lifecycle/security/data/upstream rule actually needs a decision. Do not create ADRs for ordinary implementation detail or cleanup.
- Keep TypeScript/JavaScript consistent with the owning package conventions; current SiYuan source uses semicolons and double quotes.
- Comments describe contracts, ownership, lifecycle, failure, or non-obvious constraints; do not preserve implementation diary/history in code comments.
- Markdown paragraphs are not hand-wrapped unless the owning document requires it.
- Documentation and UI copy state current truth. Do not call planned work available or verified work released.
- Never commit credentials, private workspace content, production data, secret values, hidden model prompts, or internal reasoning transcripts.

## 10. Git and GitHub

- Work on a candidate/feature branch; `main` is integration/release history.
- Use Conventional Commits for Singularity-owned changes.
- Pull requests should explain the user result, MVP classification, what was deleted/deferred, and focused verification. Do not require large evidence sections that do not improve the decision.
- History rewrites use the exact observed remote OID with `--force-with-lease`; raw `--force` is not normal development procedure.
- Do not merge, tag, publish a release, promote upstream, or deploy because checks pass. Stop for explicit maintainer approval.
- When an issue/PR exists, use the canonical full GitHub reference in long-lived documentation where appropriate; do not fabricate issue links.

## 11. Response style

Match the user's language. Keep technical identifiers in their original form and distinguish verified facts, planned work, and residual risk.
