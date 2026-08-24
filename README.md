---
title: "Singularity"
description: "An enterprise knowledge base in active development, built on the SiYuan codebase."
author: "Singularity Contributors"
date: "2026-08-24"
version: "1.2.0"
status: "draft"
tags: ["singularity", "knowledge-base", "siyuan", "agpl"]
---

# Singularity

> An enterprise knowledge base in active development, built on the SiYuan codebase.

**English** | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Türkçe](README.tr.md)

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-15 | Singularity Contributors | Replaced the upstream product page with the Singularity project entry point |
| 1.1.0 | 2026-07-17 | Singularity Contributors | Promoted the integrated SiYuan 3.7.2 commit to the upstream baseline |
| 1.2.0 | 2026-08-24 | Singularity Contributors | Completed the independent repository cutover and established explicit upstream tracking, AI engineering skills, UI governance, and impact-based CI planning |

## Table of Contents

- [Status](#status)
- [Direction](#direction)
- [Engineering and upstream governance](#engineering-and-upstream-governance)
- [Contributing and security](#contributing-and-security)
- [License and upstream](#license-and-upstream)
- [References](#references)

## Status

Singularity is under active development and is not yet a production release. Capabilities described in design or planning documents may be incomplete or unavailable; the current source code and its verification evidence are authoritative.

## Direction

The project is evolving the SiYuan foundation toward a cloud-hosted enterprise knowledge base with organization, sharing, permission, collaboration, governance, discovery, and AI-assisted capabilities. These are project goals, not a claim that every capability is already implemented.

Singularity is maintained as an independent product repository built on SiYuan. The canonical repository is `SparkElf/singularity` with canonical branch `main`. GitHub fork-network metadata is not the upstream integration mechanism: the project pins an exact SiYuan baseline, records maintained divergences, and promotes newer upstream versions through reviewed candidate branches and pull requests.

## Engineering and upstream governance

AI-assisted development follows the repository-native workflow in [`.agents/README.md`](.agents/README.md) and [`AGENTS.md`](AGENTS.md). Visible UI work follows [`docs/ui-governance.md`](docs/ui-governance.md): agents reuse the existing semantic theme and interaction primitives rather than creating a parallel design system.

The current SiYuan baseline is recorded in [`upstream/baseline.yaml`](upstream/baseline.yaml). Maintained upstream and product differences are described by [`DIFFS.md`](DIFFS.md) and the registries under `diffs/`. SiYuan `master` is treated as read-only upstream; upstream releases are analyzed before promotion and are never merged automatically into canonical `main`.

CI/CD policy is documented in [`docs/ci-cd.md`](docs/ci-cd.md). Change-impact planning fails open to full validation for unknown paths or upstream-baseline changes. A passing pull request does not authorize merge, release, upstream promotion, or deployment.

The completed transition from the legacy GitHub fork-network repository to the canonical independent repository is recorded in [`docs/repository-rebuild.md`](docs/repository-rebuild.md), with the governing decision in [ADR-038](docs/adr/0038-independent-repository-and-controlled-upstream-promotion.md).

## Contributing and security

Read the [contribution guide](.github/CONTRIBUTING.md) before proposing a change. Use the [Singularity issue tracker](https://github.com/SparkElf/singularity/issues) for reproducible defects and scoped proposals.

Report suspected vulnerabilities privately by following the [security policy](.github/SECURITY.md). Do not disclose a vulnerability in a public issue before maintainers have assessed it.

## License and upstream

Singularity is a modified work based on [SiYuan](https://github.com/siyuan-note/siyuan), currently anchored to upstream version `3.7.2` at commit `c8dcdd0860ef000a14552c619fe19c0dcb5175f5`.

The project is distributed under the [GNU Affero General Public License v3.0](LICENSE). Preserve applicable copyright, license, source-availability, and attribution notices when modifying, deploying, or redistributing it. See [NOTICE](NOTICE) for the upstream baseline and trademark attribution.

Independent repository identity does not remove or weaken the license, copyright, attribution, or source-availability obligations inherited from SiYuan.

## References

1. [Singularity repository](https://github.com/SparkElf/singularity)
2. [SiYuan upstream repository](https://github.com/siyuan-note/siyuan)
3. [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)
