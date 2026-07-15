---
title: "Contributing to Singularity"
description: "Repository workflow, quality expectations, and licensing requirements for Singularity contributions."
author: "Singularity Contributors"
date: "2026-07-15"
version: "1.0.1"
status: "approved"
tags: ["contributing", "development", "agpl"]
---

# Contributing to Singularity

> Keep changes scoped, reviewable, verifiable, and aligned with the current Singularity plan.

**English** | [中文](CONTRIBUTING.zh-CN.md)

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.1 | 2026-07-15 | Singularity Contributors | Documented required build tags for the SiYuan-derived Kernel |
| 1.0.0 | 2026-07-15 | Singularity Contributors | Established the independent Singularity contribution workflow |

## Table of Contents

- [Before making a change](#before-making-a-change)
- [Repository setup](#repository-setup)
- [Implementation and verification](#implementation-and-verification)
- [Pull requests](#pull-requests)
- [License and upstream attribution](#license-and-upstream-attribution)
- [References](#references)

## Before making a change

Search the [Singularity issue tracker](https://github.com/SparkElf/singularity/issues) before starting. Open an issue for a nontrivial feature, behavior change, migration, or architectural decision so its scope and acceptance criteria can be agreed before implementation.

Read the applicable `AGENTS.md` files and current plans in the repository. Singularity is under active development, so a planning document may describe work that is not implemented yet.

## Repository setup

Clone this repository and create a focused branch from `master`:

```bash
git clone https://github.com/SparkElf/singularity.git
cd singularity
git switch master
git switch -c your-branch-name
```

Use the tool versions declared by the repository. The Go version is defined in `kernel/go.mod`; Node and pnpm requirements are defined by the relevant package manifests and continuous-integration configuration. Before installing dependencies, review the lockfiles, registry configuration, authentication sources, and CI setup that apply to the changed module.

When building or testing the SiYuan-derived Kernel, enable CGO and pass `-tags "fts5 sqlcipher"` to both `go build` and `go test`. Continue to read tool versions and any module-specific requirements from the sources of truth above.

## Implementation and verification

- Keep each change limited to one coherent purpose.
- Preserve existing notices and clearly identify behavior inherited from SiYuan.
- Add or update verification only where the changed contract needs evidence.
- Run the lint, type-check, test, and build commands required by the applicable project guide.
- Do not include generated output or unrelated formatting changes unless the task requires them.

## Pull requests

Open pull requests against the Singularity `master` branch using the [repository pull-request page](https://github.com/SparkElf/singularity/pulls). Link the governing issue, describe user-visible and contract changes, list verification evidence, and disclose any known limitation or unverified environment.

Maintainers may ask for a change to be split when it combines unrelated behavior, refactoring, documentation, or generated artifacts.

## License and upstream attribution

By contributing, you represent that you have the right to submit the contribution and agree that it is distributed under this repository's [AGPL-3.0 license](../LICENSE). Preserve upstream and third-party copyright, license, attribution, and trademark notices.

Changes intended only for the upstream SiYuan product should be coordinated with the [SiYuan upstream repository](https://github.com/siyuan-note/siyuan). Singularity-specific reports and proposals belong in this repository.

## References

1. [Singularity repository](https://github.com/SparkElf/singularity)
2. [Singularity issue tracker](https://github.com/SparkElf/singularity/issues)
3. [Singularity notice](../NOTICE)
4. [SiYuan upstream repository](https://github.com/siyuan-note/siyuan)
