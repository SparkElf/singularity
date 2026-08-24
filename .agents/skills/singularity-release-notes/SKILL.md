---
name: singularity-release-notes
description: Use for every Singularity release candidate or GitHub Release. Describe shipped user results, SiYuan baseline, migrations, security/operator action, artifacts, and known limits without overstating readiness.
---

# Singularity Release Notes

Release notes describe the artifact users can actually obtain. They are not a copy of commit messages or a roadmap.

## Required content

- Release version and immutable commit/tag.
- Exact promoted SiYuan version and commit from `upstream/baseline.yaml`.
- User-visible improvements grouped by workflow rather than source directory.
- Important enterprise/operator changes: organization, space, permission, sharing, collaboration, AI, search, export, identity, deployment, or administration as applicable.
- Data/schema migration requirements, expected downtime, rollback boundary, and backup requirement when applicable.
- Security or privacy changes that alter permissions, credentials, model-data flow, public exposure, or operator action.
- Artifact inventory with target platform/service and immutable image/package identity.
- Known limitations and explicit labels for experimental or deferred features.
- Upstream divergences retired or materially changed in this release when that affects compatibility or maintenance.

## Release truth

Use precise labels:

- **Released** only when the artifact is published and reachable.
- **Included in source** when code merged but no release artifact exists.
- **Experimental** for intentionally unstable, opt-in capability.
- **Deferred** for planned work not present in the artifact.
- **Operator action required** when deployment/migration/configuration is necessary.

Do not claim production readiness when signing, migration evidence, supported-platform validation, deployment approval, or required artifacts remain incomplete.

## Evidence

Before publication, verify release notes against the clean-checkout artifact/container, CI evidence, diff registries, SBOM/license/security outputs promised by the release, and the exact tag. Publication still requires explicit maintainer approval.
