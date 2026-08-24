# Singularity Independent Repository Rebuild

This document defines the one-time cutover from the current GitHub fork-network repository to the canonical independent Singularity repository. The source code remains a modified work based on SiYuan and continues to follow AGPL-3.0 and attribution requirements; only the GitHub repository identity and maintenance model change.

## Goal

The canonical `SparkElf/singularity` must be created as a normal public repository, not through GitHub's **Fork** action. SiYuan remains the upstream source through explicit baseline metadata and controlled promotion.

The completed state is:

```text
siyuan-note/siyuan                 SparkElf/singularity
        upstream                         canonical product
            │                                    │
            └──── pinned baseline + diff protocol ┘
                         │
                  promotion pull request
```

GitHub fork-network metadata is deliberately not part of that relationship.

## Preserve before cutover

Before any repository rename or replacement, record and verify:

- current canonical HEAD SHA;
- all local branches intended to survive;
- all tags/releases intended to survive;
- `upstream/baseline.yaml` and the legacy `config/upstream-baseline.json` values;
- license and NOTICE files;
- workflow files and required repository variables/secrets/environments;
- issue/PR references that must remain discoverable from the legacy repository;
- repository topics, security policy, branch/ruleset configuration, and release artifacts that need recreation.

The migration branch `rebuild/independent-governance` is the source of the new governance layer.

## One-time identity cutover

1. Freeze feature merges on the current fork repository for the cutover window.
2. Rename the current GitHub fork repository from `SparkElf/singularity` to `SparkElf/singularity-legacy-fork`.
3. Create a new **empty** public repository named `SparkElf/singularity` using normal repository creation, not Fork/Import-from-fork-network behavior.
4. Push the complete intended Git history, canonical branch, migration/governance branch, and intended tags into the new repository.
5. Verify through GitHub repository metadata that the new repository reports `fork: false` and has no `parent`/`source` fork relationship.
6. Set the new repository description, topics, Issues, security policy, Discussions if desired, branch rules, Actions permissions, variables, secrets, and environments.
7. Configure the local Git relationship:
   - `origin` → `SparkElf/singularity`;
   - `upstream` → `siyuan-note/siyuan` fetch URL;
   - upstream push URL disabled.
8. Run independent governance and CI on the new repository. The governance workflow intentionally rejects a canonical repository that still reports itself as a GitHub fork.
9. Merge the governance rebuild only after required checks and maintainer review pass in the independent repository.
10. Replace the legacy fork README with a short migration notice pointing to the canonical repository, then archive the legacy repository after its references and releases are preserved.

## History policy

Do **not** squash the entire existing project into one fresh import commit. Preserve useful Git history, authorship, and the SiYuan baseline ancestry. Independence is a GitHub repository identity decision, not a requirement to erase provenance.

The new repository may therefore contain SiYuan commits in its Git graph while still being `fork: false` at the GitHub repository metadata level.

## Upstream policy after cutover

- `upstream/baseline.yaml` is the canonical promoted SiYuan baseline.
- Scheduled upstream automation discovers and analyzes changes; it never merges into the canonical branch automatically.
- A SiYuan upgrade is prepared on `upstream/siyuan-<version>` and reviewed as one promotion PR.
- Active upstream diff records must be intersected with the candidate change set.
- Equivalent upstream capabilities trigger an adopt/rebase/keep/defer decision; local implementations are retired when upstream satisfies the product requirement.

## Legacy repository policy

`singularity-legacy-fork` is evidence and redirect history, not an active development line. After cutover:

- no new feature branches originate there;
- no releases originate there;
- README points to the canonical independent repository;
- repository is archived after the migration is confirmed;
- license and upstream attribution remain intact.

## Acceptance criteria

The cutover is complete only when all of the following are true:

- `SparkElf/singularity` reports `fork: false`;
- canonical source/history and intended tags are present;
- SiYuan baseline provenance remains verifiable;
- AGPL-3.0 and NOTICE attribution remain present;
- governance workflow passes in the new repository;
- upstream remote is fetchable and non-pushable;
- required CI checks pass from a clean GitHub Actions checkout;
- legacy repository clearly redirects to the new canonical repository;
- future SiYuan changes are handled by promotion workflow rather than GitHub fork sync.
