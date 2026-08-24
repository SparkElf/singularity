# Singularity release publication

Public releases are created only by `.github/workflows/singularity-release.yml` from an explicitly created `singularity-vX.Y.Z` tag that points at the current canonical `main` HEAD.

Use `workflow_dispatch` on the release workflow for a non-publishing dry run after the workflow is present on the default branch. A dry run re-verifies repository/upstream governance and builds the API, Web, and Worker production images locally without receiving package-write or release-write authority.

Before creating a version tag, use `.agents/skills/singularity-release-notes/SKILL.md` to review shipped user results, migrations, operator action, security/privacy changes, exact SiYuan baseline, known limits, and artifact identity. Tag creation remains a maintainer decision; CI success alone does not authorize publication.
