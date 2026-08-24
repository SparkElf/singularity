# Singularity CI/CD Governance

Singularity uses change-impact planning to select credible evidence while failing open to full validation whenever a change cannot be classified safely. CI proves a candidate; CD publishes only an explicitly approved release from the independent canonical repository.

Canonical product work targets `SparkElf/singularity:main`. SiYuan tracking targets the separate read-only `siyuan-note/siyuan:master`. CI/CD documentation and scripts must keep those branch roles explicit.

## Principles

1. **Evidence follows the changed surface.** Documentation does not need PostgreSQL and Playwright; a kernel or upstream-baseline change does.
2. **Unknown means full.** The impact planner never skips checks because it failed to understand a new path.
3. **Reuse existing verification commands.** `verify:b4`, `verify:s0-s3`, browser integration, E2E, Go tests, container verification, and repository governance remain sources of truth.
4. **PR CI has read-only repository permissions.** Product tests do not receive production credentials or release secrets.
5. **Release and deployment are separate maintainer decisions.** A passing PR does not create tags, releases, images, or deployments.
6. **Upstream promotion is full-risk.** Changing the promoted SiYuan baseline selects the complete validation set.
7. **Canonical and upstream branch names are different by design.** `main` means Singularity; `upstream/master` means SiYuan.

## Impact planner

`scripts/singularity/resolve-ci-impact.mjs` maps changed paths to these logical lanes:

| Lane | Purpose |
| --- | --- |
| `governance` | Baseline/diff/PR/repository metadata and documentation contracts. |
| `native_app` | SiYuan-derived `app/**` behavior and integration. |
| `enterprise_static` | Enterprise lint, type, unit, build, and B4 contracts. |
| `integration` | Database/API/worker/kernel-service integration. |
| `browser` | Browser integration through the enterprise UI. |
| `e2e` | Real user-path Playwright evidence using CI-safe services. |
| `package` | Container/package/release-candidate build surfaces. |
| `upstream` | Upstream relationship and divergence review. |

The current routing starts conservative:

- docs/governance only → governance;
- `enterprise/apps/web/**` → enterprise static + browser + E2E;
- `enterprise/apps/api/**`, worker, shared enterprise packages → enterprise static + integration + E2E;
- `app/**` → native app + enterprise bridge/static + browser + E2E;
- `kernel/**` → integration + E2E + package;
- `upstream/baseline.yaml` or compatibility baseline metadata → full;
- unknown path → full.

The planner is allowed to become more precise only when repository evidence demonstrates that a narrower route is safe.

## Canary execution and L0 migration

The repository-identity cutover is complete, but CI responsibility migration is intentionally separate. `singularity-ci-impact.yml` now executes conservative canary lanes while `singularity-l0.yml` remains authoritative.

Current canary ownership:

- `native_app` → install the SiYuan app workspace and run native lint/tests;
- `enterprise_static` → run the existing `verify:b4` contract;
- `package` → build API/Web/Worker container candidates and verify image metadata;
- `upstream` → verify the read-only upstream relationship and generate divergence-aware impact evidence.

L0 still owns authoritative integration, PostgreSQL, Playwright/browser, real E2E, kernel-wide, supply-chain smoke, and any remaining release-grade gates. A canary pass is not evidence that an L0-required lane can be removed.

Migration sequence:

1. run independent governance and impact canaries alongside L0;
2. compare planner selections with actual L0 failures and runtime cost;
3. migrate integration/browser/E2E ownership only when the canary route demonstrates parity;
4. configure stable required checks on canonical `main`;
5. keep release-candidate full validation as a backstop;
6. retire `singularity-l0.yml` only after no unique gate remains in it.

Do not optimize runner minutes before behavioral parity is demonstrated.

## Upstream watch and promotion

The scheduled upstream workflow fetches `siyuan-note/siyuan:master` read-only and generates a report against `upstream/baseline.yaml`. The report contains:

- exact baseline and candidate commit;
- changed-path/module counts;
- merge conflicts against current Singularity HEAD;
- overlap with active `diffs/upstream/registry.yaml` records;
- product-review signals for capabilities such as AI/agent, MCP, search/discovery, identity/auth, sharing/collaboration, editor/content, and packaging;
- whether a promotion review is required.

A report is not a promotion. Promotion uses `singularity-upstream-promotion`, a candidate branch, full CI, and maintainer approval.

## Canonical release workflow

`.github/workflows/singularity-release.yml` is the only repository workflow allowed to publish Singularity artifacts. Its two modes are deliberately different:

- `workflow_dispatch` verifies a selected canonical ref and builds all three production images locally, but **never publishes**;
- pushing `singularity-vX.Y.Z` publishes only when that tag points at the current canonical `main` HEAD.

The release verify job re-checks repository/upstream governance, runs L0 governance tests, builds API/Web/Worker images from the tagged source, and validates OCI metadata before any registry write is possible.

On an approved version tag the publish jobs create:

- `ghcr.io/sparkelf/singularity-api:<version>` and `sha-<commit>`;
- `ghcr.io/sparkelf/singularity-web:<version>` and `sha-<commit>`;
- `ghcr.io/sparkelf/singularity-worker:<version>` and `sha-<commit>`.

GHCR publication uses BuildKit SBOM and provenance attestations. After all images publish successfully, the workflow creates an immutable GitHub Release containing the Singularity commit, promoted SiYuan baseline, image inventory, and generated repository release notes. An existing GitHub Release with the same tag is never mutated by the workflow.

## Release permissions

The release workflow keeps top-level permissions at `contents: read`. Write capability is job-scoped:

- image publication job: `contents: read`, `packages: write`;
- GitHub Release job: `contents: write` only.

No job receives both package-write and contents-write authority, and the workflow has no `pull_request` trigger. The repository verifier explicitly permits this narrow release exception while all other workflows remain read-only and may not add job-level write permissions.

OIDC is not granted merely for future signing plans. Add `id-token: write` only when a concrete provenance/signing mechanism requires it and its verifier is updated in the same change.

## Deployment pipeline

Production deployment remains a later layer on top of immutable released artifacts:

```text
GitHub Release / immutable image digest
        ↓
staging deploy
        ↓
health + migration + smoke + rollback evidence
        ↓
manual production approval
        ↓
production deploy by digest
        ↓
post-deploy health and rollback checkpoint
```

Do not deploy canonical `main`, a mutable image tag, or an unreviewed upstream-promotion candidate directly to production. Deploy only an approved immutable release artifact/digest.

## Release acceptance criteria

A public Singularity release is ready only when:

- the canonical repository is independent (`fork: false`);
- the release tag identifies current canonical `main` HEAD;
- all required CI and governance checks pass before the maintainer creates the version tag;
- the release dry-run can build and verify API/Web/Worker image metadata from a clean checkout;
- the exact SiYuan baseline and active divergences are recorded;
- migrations and rollback boundaries are documented and verified when applicable;
- published images use version and immutable source-SHA identities;
- license/NOTICE/SBOM/security evidence is present at the level promised by the release;
- release notes distinguish shipped, experimental, deferred, and operator-required work;
- a maintainer explicitly approves tag creation and publication.
