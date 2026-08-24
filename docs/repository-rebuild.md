# Singularity Independent Repository Rebuild

This document defines the one-time cutover from the historical GitHub fork-network repository to the canonical independent Singularity repository. The source code remains a modified work based on SiYuan and continues to follow AGPL-3.0 and attribution requirements; only the GitHub repository identity and maintenance model change.

## Goal

The canonical `SparkElf/singularity` is a normal public repository, not a GitHub Fork. SiYuan remains the upstream source through explicit baseline metadata and controlled promotion.

```text
siyuan-note/siyuan                 SparkElf/singularity
        upstream                         canonical product
            │                                    │
            └──── pinned baseline + diff protocol ┘
                         │
                  promotion pull request
```

GitHub fork-network metadata is deliberately not part of that relationship.

## Cutover record

The repository-identity cutover was performed on 2026-08-24.

- The historical fork was renamed to `SparkElf/singularity-legacy-fork`; it remains `fork: true` with `siyuan-note/siyuan` as parent/source.
- A new empty public `SparkElf/singularity` was created normally and verified as `fork: false` with no parent/source relationship.
- The prepared `rebuild/independent-governance` history was imported without rewriting historical SiYuan or Singularity commits. The original SiYuan baseline commit `c8dcdd0860ef000a14552c619fe19c0dcb5175f5` and the prepared governance commit `31728a508a27d52d9a88fb225183e9ca4405dcfa` remain original Git objects in the canonical ancestry.
- GitHub's repository `GITHUB_TOKEN` was empirically verified to allow ordinary content pushes but not a direct default-branch workflow-file update. The import therefore used a new branch whose temporary tip removed `.github/workflows`; historical workflow commits remained unchanged ancestors. The current governed workflows are restored through the GitHub repository connection before canonical `main` is activated.
- The canonical branch is `main`. SiYuan's tracked upstream branch remains `master`; these names are intentionally independent.

The remaining cutover closeout is operational: run canonical governance/CI, replace the legacy README with a redirect, recreate desired repository metadata/rules, and archive the legacy repository after its references are no longer needed for active work.

## Preserve before cutover

Before any repository rename or replacement, record and verify:

- current canonical HEAD SHA;
- local branches/tags/releases intended to survive as active refs;
- `upstream/baseline.yaml` and compatibility metadata;
- license and NOTICE files;
- workflow files and required repository variables/secrets/environments;
- issue/PR references that must remain discoverable from the legacy repository;
- repository topics, security policy, branch/ruleset configuration, and release artifacts that need recreation.

The migration branch `rebuild/independent-governance` was the source of the new governance layer. Historical auxiliary branches and fork-network metadata remain discoverable in `singularity-legacy-fork`; the canonical repository preserves the history reachable from the promoted product line rather than treating every legacy branch as an active product branch.

## One-time identity cutover

1. Freeze feature merges on the fork repository for the cutover window.
2. Rename it from `SparkElf/singularity` to `SparkElf/singularity-legacy-fork`.
3. Create a new **empty** public repository named `SparkElf/singularity` using normal repository creation, not Fork/Import-from-fork-network behavior.
4. Import the intended product history without squashing or rewriting product/upstream commits.
5. Verify that the new repository reports `fork: false` and has no `parent`/`source` fork relationship.
6. Make `main` the canonical integration branch and keep SiYuan `master` only as the explicit upstream branch.
7. Restore only the current Singularity-owned workflows and verify their repository guards and least-privilege permissions.
8. Configure local Git with `origin` → `SparkElf/singularity`, `upstream` → `siyuan-note/siyuan`, and upstream push disabled.
9. Run independent governance and CI on the canonical repository.
10. Replace the legacy fork README with a migration notice and archive the legacy repository after retained references/releases are accounted for.

## History policy

Do **not** squash the existing project into one fresh import commit. Preserve useful Git history, authorship, and SiYuan baseline ancestry. Independence is a GitHub repository identity decision, not a requirement to erase provenance.

The canonical repository can therefore contain SiYuan commits in its Git graph while still being `fork: false` in GitHub repository metadata. Repository identity and Git ancestry are different concerns.

## Upstream policy after cutover

- `upstream/baseline.yaml` is the canonical promoted SiYuan baseline.
- `main` is the Singularity canonical branch; `upstream/master` is the read-only SiYuan tracking branch.
- Scheduled upstream automation discovers and analyzes changes; it never merges into `main` automatically.
- A SiYuan upgrade is prepared on `upstream/siyuan-<version>` and reviewed as one promotion PR.
- Active upstream diff records are intersected with the candidate change set.
- Equivalent upstream capabilities trigger an adopt/rebase/keep/defer decision; local implementations are retired when upstream satisfies the product requirement.

## Legacy repository policy

`SparkElf/singularity-legacy-fork` is evidence and redirect history, not an active development line. After cutover:

- no new feature branches originate there;
- no releases originate there;
- its README points to the canonical independent repository;
- it is archived after migration closeout;
- license and upstream attribution remain intact.

## Acceptance criteria

The cutover is complete only when all of the following are true:

- `SparkElf/singularity` reports `fork: false`;
- canonical source/history is present and important source/baseline commits retain their original SHAs;
- SiYuan baseline provenance remains verifiable;
- AGPL-3.0 and NOTICE attribution remain present;
- current Singularity workflows are restored in the canonical repository;
- governance and required CI checks pass from a clean GitHub Actions checkout;
- upstream remains fetch-only/non-pushable in verification jobs and documented local setup;
- legacy repository clearly redirects to the new canonical repository;
- future SiYuan changes are handled by controlled promotion rather than GitHub fork sync.
