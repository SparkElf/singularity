# AGENTS.md

Singularity is an independent enterprise knowledge-base product built on the SiYuan codebase. The canonical repository is intended to be a **non-fork GitHub repository**; SiYuan is tracked explicitly through `upstream/baseline.yaml`, `diffs/`, and controlled promotion pull requests.

Before non-mechanical work, read:

1. `.agents/README.md` — required AI engineering sequence and authority.
2. `DIFFS.md` — upstream/product divergence protocol.
3. `upstream/baseline.yaml` — exact promoted SiYuan baseline.
4. `docs/ui-governance.md` — required UI ownership rules for visible changes.
5. The relevant skill under `.agents/skills/`.

## 1. Required engineering sequence

For non-mechanical product changes use, in order:

1. `singularity-product-design`
2. `singularity-architecture-planning`
3. `singularity-frontend-design` when visible UI changes
4. `singularity-implementation`
5. `singularity-code-review`
6. `singularity-test-governance`
7. `singularity-verification`

Use `singularity-maintain-diffs` whenever SiYuan-derived code, product-owned enterprise behavior, or the upstream baseline changes. Use `singularity-upstream-promotion` for any SiYuan version/commit promotion.

A passing CI run does not authorize merge, upstream promotion, release, or deployment. Those require an explicit maintainer decision.

## 2. Architecture and ownership

Singularity has three important code ownership planes:

| Plane | Paths | Owner |
| --- | --- | --- |
| SiYuan native runtime | `kernel/**`, `app/**` | Upstream-derived. Keep local changes narrow and promotable. |
| Singularity enterprise platform | `enterprise/**`, `config/**` | Product-owned organization, identity, space, sharing, permission, collaboration, web/API/worker, governance, export, discovery, and enterprise integrations. |
| Repository/product governance | `.agents/**`, `.github/**`, `diffs/**`, `upstream/**`, `scripts/singularity/**`, product docs/release assets | Singularity-owned. |

The Go kernel remains the native content/data engine. The SiYuan TypeScript frontend remains the native workspace/editor owner. Enterprise React UI is mounted as a Singularity-owned product surface; do not create a second owner for native document/editor state.

### Core SiYuan layout

- `kernel/`: Go backend, API, content trees, SQLite/indexing, sync, AI/MCP, server, mobile bindings.
- `app/`: SiYuan native TypeScript/Electron/web UI and Protyle editor.
- `app/stage/`: build/runtime assets; many generated artifacts are not hand-edited.

### Enterprise layout

- `enterprise/apps/web/`: React/Vite enterprise UI and Playwright browser evidence.
- `enterprise/apps/api/`: enterprise API/control-plane service.
- `enterprise/apps/worker/`: background work.
- `enterprise/packages/`: shared enterprise packages and contracts.

## 3. Upstream policy

- Upstream repository: `siyuan-note/siyuan`.
- The exact promoted version/commit lives only in `upstream/baseline.yaml` plus compatibility metadata required by existing build tooling.
- Never treat GitHub fork metadata as the upstream tracking mechanism.
- Never automatically merge SiYuan `master` into the canonical branch.
- Upstream automation may discover, compare, report, and prepare a candidate branch/PR; it must not silently move the canonical baseline.
- A promotion candidate is named `upstream/siyuan-<version>` and must classify every impacted active divergence as adopt-upstream, rebase-local, keep-local, or defer.
- If upstream now satisfies a local capability, prefer retiring the local divergence over maintaining two implementations.

## 4. Diff governance

`diffs/upstream/registry.yaml` records maintained SiYuan-derived divergences. `diffs/product/registry.yaml` records Singularity-owned product capabilities whose lifecycle matters across releases/upstream promotions.

A record uses a stable ID and one of `planned`, `active`, or `retired`. New work should be capability-specific. Do not expand the broad bootstrap record merely to avoid creating a real record.

Any PR changing `app/**` or `kernel/**` must update `diffs/upstream/registry.yaml` in the same PR. Baseline changes also update upstream diff metadata.

## 5. UI engineering rules

Visible UI work must use `singularity-frontend-design` and `docs/ui-governance.md`.

### Enterprise React UI

- `enterprise/apps/web/src/styles.css` is the current semantic theme owner.
- `enterprise/apps/web/src/components/ui/` owns reusable React interaction primitives.
- Feature packages consume those owners; they do not create another global theme, icon system, spacing scale, or component library.
- Light and dark themes share geometry, hierarchy, and interaction; theme branches change semantic values, not component structure.
- Implement loading, empty, failure/recovery, permission, disabled, focus/keyboard, success, long-content, and overflow states that belong to the accepted user path.
- Screenshots are visual evidence only. Playwright or the applicable browser flow must operate the real user path.

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

Common checks:

```sh
cd app && pnpm run lint
cd enterprise && pnpm install --frozen-lockfile
cd enterprise && pnpm run test:l0-governance
cd enterprise && pnpm verify:b4
cd enterprise && pnpm verify:s0-s3
cd enterprise && pnpm test:e2e
node scripts/singularity/verify-independent-governance.mjs
```

Select checks through `singularity-test-governance`; do not run unrelated exhaustive suites merely for ceremony. Baseline promotions and release candidates are exceptions and require broader evidence.

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

## 9. Coding and documentation

- Keep TypeScript/JavaScript consistent with the owning package conventions; current SiYuan source uses semicolons and double quotes.
- Comments describe contracts, ownership, lifecycle, failure, or non-obvious constraints; do not preserve implementation diary/history in code comments.
- Markdown paragraphs are not hand-wrapped unless the owning document requires it.
- Documentation and UI copy state current truth. Do not call planned work available or verified work released.
- Never commit credentials, private workspace content, production data, secret values, hidden model prompts, or internal reasoning transcripts.

## 10. Git and GitHub

- Work on a candidate/feature branch; the canonical branch is integration/release history.
- Use Conventional Commits for Singularity-owned changes.
- Pull requests must preserve the evidence headings in `.github/PULL_REQUEST_TEMPLATE.md`.
- Do not merge, tag, publish a release, promote upstream, or deploy because checks pass. Stop for explicit maintainer approval.
- When an issue/PR exists, use the canonical full GitHub reference in long-lived documentation where appropriate; do not fabricate issue links.

## 11. Response style

Match the user's language. Keep technical identifiers in their original form and distinguish verified facts, planned work, and residual risk.
