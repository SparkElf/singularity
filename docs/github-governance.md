# GitHub Repository Governance

This document owns the GitHub settings that cannot be expressed only through source code. The machine-readable target is [`.github/repository-governance.json`](../.github/repository-governance.json).

## Repository identity

- Canonical repository: `SparkElf/singularity`
- Canonical branch: `main`
- Visibility: public
- GitHub fork relationship: none; the repository must remain `fork: false`
- SiYuan upstream: `siyuan-note/siyuan:master`, tracked through `upstream/baseline.yaml` rather than GitHub Fork Network metadata

## Discoverability metadata

Use this repository description:

> Singularity: an enterprise knowledge base built on SiYuan for organization, sharing, permissions, collaboration, governance, discovery, and AI-assisted knowledge work.

Keep homepage empty until Singularity has an owned public site. Use these topics:

`enterprise-knowledge-base`, `knowledge-base`, `knowledge-management`, `siyuan`, `self-hosted`, `collaboration`, `permissions`, `ai-agents`, `mcp`, `typescript`, `golang`, `react`, `postgresql`, `local-first`.

Do not use SiYuan/B3log project URLs as the Singularity homepage merely to fill the field.

## Repository features

- Issues: enabled.
- Projects: enabled while the repository uses GitHub Projects for planning; disable only when another owned tracker replaces it.
- Wiki: disabled; durable documentation belongs in the repository where it is versioned and reviewed.
- Discussions: enabled for design/community conversations that are not actionable defects or scoped implementation tasks.

## `main` ruleset

Protect `main` as integration/release history.

Required rules:

- require a pull request before ordinary changes reach `main`;
- block force pushes and branch deletion;
- require resolution of review conversations;
- require the canonical governance and L0 status checks after GitHub has observed their exact check contexts on the first canonical pull request;
- do not require linear history because SiYuan upstream promotion may intentionally preserve an auditable merge relationship;
- do not require a separate approving CODEOWNER review while there is only one human maintainer: GitHub cannot let an author satisfy their own required approval;
- keep automatic merge disabled; passing checks are evidence, not merge authority.

The intended required check contexts are recorded in `.github/repository-governance.json`. Confirm their exact names from the first canonical pull request before configuring the ruleset; do not guess a context name and permanently block `main`.

When a second human maintainer can provide independent review, raise the required approving review count and optionally require CODEOWNER review as a separate governance change.

## Merge methods

Keep merge, squash, and rebase available for normal pull requests while choosing history deliberately:

- normal independent changes may squash or rebase when their review history does not need a merge commit;
- upstream promotion should preserve its explicit upstream provenance and normally uses a merge relationship documented by the promotion PR/ADR;
- raw force pushes are not normal development procedure; an explicitly authorized history rewrite uses `--force-with-lease` against the observed remote OID.

Do not enable linear-history enforcement while the controlled upstream-promotion contract relies on preserved upstream ancestry.

## CODEOWNERS

`.github/CODEOWNERS` records current responsibility and future review routing. It does not by itself create a second approval requirement. When ownership changes, update CODEOWNERS and the corresponding product/diff/ADR owner in the same change where applicable.

## Legacy repository

`SparkElf/singularity-legacy-fork` is historical evidence, not an active product line. Its README redirects to canonical Singularity. Archive it after canonical CI and any retained release/issue references have been checked. Do not delete it merely to remove the old Fork Network relationship; its history is useful migration evidence.

## Release settings

Do not grant broad repository write permissions to PR workflows. A future dedicated release workflow may receive only the permissions required to create a GitHub Release, publish immutable GHCR packages, and produce provenance/signing evidence. Release/tag creation remains an explicit maintainer action.

## Drift review

Review GitHub settings whenever any of these change:

- canonical branch or repository identity;
- maintainer/reviewer topology;
- required CI check names;
- release workflow permissions;
- public homepage/community surfaces;
- upstream promotion/history policy.

Repository settings are part of the product's maintenance contract even when they are not stored directly in Git objects.
