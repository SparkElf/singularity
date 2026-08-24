# Singularity CI/CD Governance

Singularity uses change-impact planning to select credible evidence while failing open to full validation whenever a change cannot be classified safely. CI proves a candidate; CD publishes only an explicitly approved release from the independent canonical repository.

## Principles

1. **Evidence follows the changed surface.** Documentation does not need PostgreSQL and Playwright; a kernel or upstream-baseline change does.
2. **Unknown means full.** The impact planner never skips checks because it failed to understand a new path.
3. **Reuse existing verification commands.** `verify:b4`, `verify:s0-s3`, browser integration, E2E, Go tests, and repository governance remain sources of truth.
4. **PR CI has read-only repository permissions.** Product tests do not receive production credentials or release secrets.
5. **Release and deployment are separate maintainer decisions.** A passing PR does not create tags, releases, images, or deployments.
6. **Upstream promotion is full-risk.** Changing the promoted SiYuan baseline selects the complete validation set.

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
- `upstream/baseline.yaml` or legacy baseline metadata → full;
- unknown path → full.

The planner is allowed to become more precise only when repository evidence demonstrates that a narrower route is safe.

## Migration from `singularity-l0.yml`

The existing L0 workflow remains authoritative during the repository-identity transition. It is not deleted until the replacement CI has demonstrated parity on the independent repository.

Migration sequence:

1. land governance and impact planning;
2. run the new planner alongside L0 and compare selected lanes with actual L0 failures;
3. split stable responsibilities into governance/static/integration/e2e/package workflows or jobs;
4. configure required checks on the independent repository;
5. keep scheduled full validation as a backstop;
6. retire `singularity-l0.yml` only after no unique gate remains in it.

Do not optimize runner minutes before behavioral parity is demonstrated.

## Upstream watch and promotion

The scheduled upstream workflow fetches `siyuan-note/siyuan` read-only and generates a report against `upstream/baseline.yaml`. The report contains:

- exact baseline and candidate commit;
- changed-path/module counts;
- merge conflicts against current Singularity HEAD;
- overlap with active `diffs/upstream/registry.yaml` records;
- product-review signals for capabilities such as AI/agent, MCP, search/discovery, identity/auth, sharing/collaboration, editor/content, and packaging;
- whether a promotion review is required.

A report is not a promotion. Promotion uses `singularity-upstream-promotion`, a candidate branch, full CI, and maintainer approval.

## Release pipeline after independent cutover

The first CD target is reproducible release publication, not unattended production deployment.

```text
approved release commit
        │
        ├── full CI
        ├── clean-checkout build
        ├── API container
        ├── Web container
        ├── Worker container
        ├── SBOM / license / vulnerability evidence
        ├── checksums / provenance metadata
        ▼
   release approval
        │
        ├── tag singularity-vX.Y.Z
        ├── publish immutable GHCR images
        └── create GitHub Release with artifact/evidence links
```

The repository already contains Dockerfiles for the enterprise Web and API services; release implementation must inventory all production services, including Worker, before claiming a complete deployment bundle.

## Release permissions

Release publishing is intentionally not enabled on the legacy fork. After the new canonical repository reports `fork: false`, a dedicated release workflow may receive the minimum permissions required for its actions, for example repository contents for release creation, package write for GHCR, and OIDC only when provenance/signing actually uses it.

Those permissions belong only to the release workflow. PR workflows remain read-only and never receive release credentials.

## Deployment pipeline

Production deployment is a later layer on top of immutable released artifacts:

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

Do not deploy `master`, a mutable image tag, or an unreviewed upstream-promotion candidate directly to production.

## Release acceptance criteria

A public Singularity release is ready only when:

- the canonical repository is independent (`fork: false`);
- all required CI and governance checks pass;
- the exact SiYuan baseline and active divergences are recorded;
- migrations and rollback boundaries are documented and verified when applicable;
- built artifacts/images are produced from the release commit and identified immutably;
- license/NOTICE/SBOM/security evidence is present at the level promised by the release;
- release notes distinguish shipped, experimental, deferred, and operator-required work;
- a maintainer explicitly approves tag and publication.
