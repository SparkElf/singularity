---
title: "Singularity Security Policy"
description: "Private reporting and assessment policy for suspected Singularity vulnerabilities."
author: "Singularity Contributors"
date: "2026-07-15"
version: "1.0.0"
status: "approved"
tags: ["security", "vulnerability-disclosure"]
---

# Singularity Security Policy

> Report suspected vulnerabilities privately so maintainers can assess impact before public disclosure.

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-15 | Singularity Contributors | Established the Singularity vulnerability-reporting policy |

## Table of Contents

- [Supported code](#supported-code)
- [Private reporting](#private-reporting)
- [Assessment](#assessment)
- [Disclosure](#disclosure)
- [References](#references)

## Supported code

Singularity is under active development and has not yet published a production-ready release. Maintainers assess reports against the current `master` branch and any release branch explicitly identified as supported in this repository.

## Private reporting

Submit a report through [Singularity private vulnerability reporting](https://github.com/SparkElf/singularity/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include the affected revision, deployment context, prerequisites, reproduction steps, demonstrated impact, and any suggested mitigation. Remove credentials, personal data, workspace contents, session tokens, and other secrets from the report and its attachments.

## Assessment

Reports are evaluated case by case using demonstrated impact, reachability, trust boundaries, and documented behavior. No vulnerability category is excluded in advance; reports involving injection, server-side request forgery, authorization bypass, unauthorized file access, or unsafe content handling are assessed under the same evidence-based process.

Behavior inherited unchanged from SiYuan may also affect its upstream users. The Singularity maintainers will identify upstream relevance during triage and coordinate disclosure when appropriate.

## Disclosure

Keep report details private until maintainers have completed an initial assessment and coordinated a disclosure plan with the reporter and any affected upstream project. Acknowledgement, remediation, and publication timing depend on severity, reproducibility, and the scope of the required fix; this policy does not promise a fixed response time.

## References

1. [Singularity private vulnerability reporting](https://github.com/SparkElf/singularity/security/advisories/new)
2. [Singularity issue tracker](https://github.com/SparkElf/singularity/issues)
3. [Singularity notice](../NOTICE)
