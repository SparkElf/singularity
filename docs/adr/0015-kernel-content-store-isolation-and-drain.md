---
title: "ADR-015: Kernel content-store isolation and encrypted-box drain"
description: "Make notebook identity authoritative for Kernel routing and drain accepted writes before locking encrypted notebooks"
author: "Codex"
date: "2026-07-16"
version: "1.4.0"
status: "accepted"
tags: ["adr", "kernel", "encryption", "transactions", "p1-b4"]
---

# ADR-015: Kernel content-store isolation and encrypted-box drain

## Status

Accepted

## Context

P1-B4 makes `notebookId` the authoritative content-store identity. Several legacy Kernel loaders still interpreted an empty notebook as permission to search every opened encrypted notebook. `LockBox` also checked queue state without blocking new transaction or index admission, so a write could enter after the apparent flush and reach a closing SQLCipher database. The new `SwapBlockRefInBox` path could write two encrypted trees separately and leave a half-swapped state after the first failure.

These are isolation and durability defects, not compatibility cases. A missing identity must not be repaired by searching other stores, and locking must not report completion while an accepted write can still produce encrypted output. Review also found three longer windows that the first drain contract did not cover: non-transaction writers can write a file before entering SQL admission, derived reference work can lose the source store, and an API can serialize plaintext after its model read lock has already ended. Existing `recent-doc.json` rows also predate notebook identity and cannot be discarded during upgrade. Holding the lifecycle read lock directly from notebook parsing through JSON serialization is not safe: filesys and AV reads acquire the same lock internally, and Go's writer-preferring `RWMutex` blocks that nested read after `LockBox` has queued a writer. Some reads can also repair indexes or acquire the box operation gate, so response ownership must precede operation, SQL admission and lifecycle ownership. Recent-document persistence must not copy derived encrypted titles or icons into the global storage file.

## Decision

1. `notebook` is the single Kernel content-store routing field. An absent or empty value means the ordinary global content store only. An explicit encrypted notebook selects exactly that store. Global loaders, reindexing and existence checks never enumerate opened encrypted notebooks.
2. Every encrypted document transaction carries the Protyle owner's immutable `notebookId` as `notebook`. Transaction loading and insertion consume that field directly; no block ID, path, open-store list or response may infer it. Ordinary transactions retain the empty global identity.
3. `LockBox` obtains the per-box response write gate and then the operation gate, closes transaction admission, waits for all already accepted work, drains content-index admission and durable queues, then obtains the box lifecycle write lock. Failure to drain leaves the DEK and database usable and returns an error. Polling, fixed sleeps and unsynchronized queue-length checks are removed.
4. Lock order is fixed as follows: unlock uses `notebookCryptoMu -> response write -> box operation -> box lifecycle write`; an encrypted plaintext response uses `response read -> box operation when required -> ordinary admission -> box lifecycle read`; ordinary non-response work uses box operation when required, then admission read before box lifecycle read; lock uses `response write -> box operation -> transaction drain -> SQL drain -> box lifecycle write`. The response writer is acquired first so an accepted read can finish operation-guarded lookups and any required reindex work. No path may acquire a response gate while holding the box operation gate, transaction/SQL admission or a lifecycle lock.
5. The new encrypted `SwapBlockRefInBox` path supports same-tree swaps only in this phase. A cross-tree target returns an explicit error before either tree, block-tree index or content index changes. The existing ordinary global path is not broadened by this decision. Supporting encrypted cross-tree swaps later requires a separate durable two-file journal and atomic index batch.
6. Encrypted asset search holds the box response read gate through response serialization. A per-box asset commit lock covers the strict name-map snapshot plus directory listing on reads and the encrypted file plus name-map update on writes. Copied DEKs are zeroed on every exit path.
7. Every coalesced SQL operation uses `(action, boxID, object identity)` as its key. Tree and block operations use the explicit box plus ID; path deletion uses the explicit box plus path. The in-memory operation and its durable queue entry always describe the same content store. `IndexNodeQueue` receives its store explicitly instead of looking it up from a global block tree.
8. A non-transaction content commit acquires one composition token in the fixed order `SQL admission read -> box lifecycle read`, then retains both capabilities until file write, plaintext cache update, block-tree mutation and durable SQL enqueue have all completed. Caller-owned-lock variants perform the inner file and queue work without recursively acquiring either lock. Transactions remain covered by transaction admission and use the same ordered SQL/lifecycle token during commit. After obtaining the response write gate, `LockBox` keeps the inverse commit-control sequence `close transaction admission -> acquire SQL admission write -> acquire lifecycle write`, so accepted work completes while new work stops before it can emit encrypted output.
9. Derived work uses a composite `{boxID, objectID}` identity from source to sink. Reference cache misses query the selected SQL store; dynamic anchor trees, attribute views and delayed reference-count tasks retain the same box; cache invalidation removes the same composite key. No derived task may collapse entries by a bare block or root ID.
10. An API that resolves a non-empty encrypted `notebook` registers that box on the Gin request context. API middleware acquires the independent per-box response read gate at registration and releases it only after the synchronous handler and `c.JSON` response write have returned. `LockBox` and `UnlockBox` acquire the matching response write gate before the box operation or lifecycle gates, so nested model/filesys/AV work remains unblocked and no prior plaintext response survives a completed lock. Each ordinary content handler resolves one notebook identity once. The recent-document aggregate is the only multi-box response: before enumerating members it acquires `notebookCryptoMu`, then acquires every configured encrypted response gate in sorted order and retains both the control-plane lock and response gates through JSON serialization. Encrypted notebook creation, deletion and unlock share that control-plane lock, while direct lock waits on the acquired response gate, so the aggregate cannot enumerate one membership set and read another. This guard applies to document, block, search, backlink, outline and other plaintext responses, not only asset search.
11. A supplied `notebook` is validated even when it names an ordinary notebook. Invalid, missing or malformed supplied identities fail explicitly; only an omitted field selects the ordinary global content store. Search endpoints use the same parser as every other content API.
12. Legacy recent-document rows without `notebookId` enter a one-time migration path. The migrator runs only while every configured encrypted block-tree store is open, examines the ordinary store plus those encrypted stores, assigns a notebook only when exactly one store owns the root, and otherwise preserves the original row unchanged for a later unlock. The persistence schema contains only root identity, notebook identity and timestamps; title and icon remain response-only derived fields. This bounded migration is the sole content-store enumeration exception: it never chooses an ambiguous match and is removed once no legacy rows remain.

No compatibility bridge, global fallback, second notebook field or inferred identity remains.

## Verification

| Stable contract | Lowest sufficient evidence |
| --- | --- |
| Empty notebook cannot read an opened encrypted store | Go integration tests for global loaders, existence checks and reindexing |
| Explicit encrypted transactions affect only their selected store | Go transaction contract/integration tests plus App payload type/build evidence |
| Lock waits for accepted transaction and SQL work and rejects new admission | Channel-controlled Go concurrency tests with no fixed sleep |
| Drain failure keeps the box unlocked and usable | Go failure-path integration test |
| Encrypted cross-tree swap changes neither tree nor index | Go integration test; same-tree success remains covered |
| Asset search cannot serialize plaintext names after lock completion | Handler/model concurrency test and writer rollback cases |
| A non-transaction writer cannot write, refill plaintext cache or enqueue after lock completion | Channel-controlled Go integration test spanning file write, cache, block-tree and durable queue |
| Two stores with the same object ID retain both normal and recovered queue operations | Go queue integration tests for in-memory flush and durable restart recovery |
| Derived refs, dynamic anchors, attribute views and delayed refcounts stay in their source store | Real SQLite and block-tree integration tests with duplicate IDs in two stores |
| Explicit invalid notebook identity never falls through to global search | Real Gin HTTP contract tests |
| Encrypted plaintext is serialized before `LockBox` can return without nested-read deadlock | Channel-controlled Gin response-writer integration test that performs a real nested content read |
| Recent-document membership cannot change between gate acquisition and serialization | Gin integration test with real encrypted stores, blocked JSON serialization and concurrent encrypted notebook creation |
| Legacy recent documents migrate only when every store is inspectable and ownership is unique | Go storage migration tests with ordinary, encrypted, ambiguous and locked stores |
| Recent-document persistence never stores derived title or icon plaintext | Raw JSON persistence assertions before and after migration |

Tests use the repository's Go test runner and existing package test files. They assert observable storage, response and lock outcomes rather than source strings, private scheduling guesses or full internal mocks.

## Alternatives

- Keep global fallback for legacy callers: rejected because it makes a missing identity a cross-store read capability.
- Flush until queue lengths appear empty: rejected because observation is not an admission barrier and cannot order future writers.
- Implement encrypted cross-tree swap with two independent writes: rejected because failure can persist a mixed state.
- Add a two-file journal in B4: deferred because it introduces recovery state, startup replay and atomic index batching beyond the approved runtime-closure scope.
- Hold only the lifecycle lock inside encryption helpers: rejected because file writes, cache updates, block-tree changes and durable queue admission occur after encryption returns.
- Hold the lifecycle read lock from request parsing through JSON: rejected because a queued lifecycle writer blocks the same request's nested filesys/AV read lock and deadlocks. Moving those inner reads to caller-owned variants would spread lease plumbing across the entire content read graph.
- Close SQL admission before waiting for plaintext responses: rejected because a read may repair an index after response registration, creating `response read -> SQL admission read` versus `SQL admission write -> response write` inversion.
- Acquire the box operation gate before the response writer: rejected because block and search responses register `response read` before entering operation-guarded model code, creating an operation/response ABBA cycle.
- Add an independent content-writer counter: rejected because SQL admission already defines the durable commit boundary; a second gate would duplicate state and make lock order harder to audit.
- Copy plaintext results before releasing the lifecycle lock: rejected because the response would still be emitted after lock completion and copying creates another sensitive buffer without fixing lifecycle ownership.
- Drop legacy recent-document rows or infer the first matching notebook: rejected because both choices silently lose user history or make ambiguous identity authoritative.

## Consequences

- Callers that previously omitted encrypted notebook identity now fail explicitly and must pass the owner identity.
- Locking may wait for accepted work or return a drain error; it cannot silently discard work or close the database early.
- Encrypted cross-tree block swapping is unavailable until a durable batch protocol is designed and verified.
- The content-store model becomes direct: identity is selected once, every loader consumes it, and empty identity has one global-only meaning.
- Queue admission becomes an explicit capability for multi-step content commits; inner locked methods are not general fallback APIs.
- Plaintext response latency now contributes to lock and unlock latency through a dedicated gate, which is required for the promise that lifecycle transitions never strand nested content reads and lock completion ends all prior plaintext output.
- Legacy recent-document migration may remain pending while an encrypted notebook is locked or identity is ambiguous; the row remains durable rather than being guessed or deleted.
- The recent-document aggregate briefly holds the encrypted-notebook control plane and all configured encrypted response gates, so create, delete and unlock operations wait for serialization; it neither decrypts locked stores nor persists derived titles or icons.

## Implementation order

1. Make queue coalescing and `IndexNodeQueue` store-aware; prove both content stores remain accepted.
2. Add the ordered content-commit token and caller-owned-lock file/queue methods; migrate every file/cache/block-tree/queue sequence as one batch.
3. Carry composite identity through reference caches, dynamic anchors, attribute views and delayed refcounts.
4. Add the per-box response gate ahead of lifecycle and admission writers, register it on the API context and migrate every plaintext explicit-notebook parser call; then make search use that parser.
5. Add the legacy recent-document migrator and replace the destructive old-schema expectation.
6. Run focused concurrency and cross-store tests, then the changed Kernel package aggregate before code re-review.

## References

1. [Protyle runtime closure PRD](../product/protyle-runtime-closure.md)
2. [Protyle browser host architecture](../architecture/protyle-browser-host.md)
3. [ADR-010: Protyle host actions and contract ownership](0010-protyle-host-actions-and-contract-ownership.md)
