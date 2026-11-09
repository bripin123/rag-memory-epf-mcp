# model-on-demand — the embedding model is in memory only while it is being used

Branch: `feat/model-on-demand`.
Decision record (hub): `raw/advisor/2026-11-09-in46/DECISION.md` (request `BRIEF-r1-2_.md` · designs `1_-design.md`, `2_-r1.md` · measurements `measure/`).

## Problem (measured 2026-11-09, macOS, 6.4.4)

- `lazy` loaded the model right after connect and never released it. Five running engines held 1,972-2,061 MB each by `phys_footprint` (about 10.1 GB); an engine without the model holds 130-204 MB.
- The model is used in bursts. Most of a session's lifetime it sits unused.

## Requirement (owner)

1. Booting does not load the model.
2. It loads when a search or a write needs it.
3. A model that is merely out of memory never makes a search skip the vector path or a write skip its vector: the caller waits.
4. After an idle period it leaves memory.
5. FTS-only answers remain for exactly: the model files are not on the machine yet, or loading really failed (a caller that has waited 45 s counts as this, for that request).
6. This is the default. Search ranking, the model and the DB schema do not change.

## Decision

Same process, inside `EmbeddingGate`, which already owns the model lifecycle. A separate model process would return the remaining ~0.5 GB but adds process lifecycle, IPC and Windows kill paths (the alternative design estimated 400-600 net lines over 18-24 files). It stays available if the residual turns out to matter.

`eager` keeps the model resident and is the way out. `off` is unchanged. Two existing FTS paths stay: `off`, and provenance reconciliation of a legacy DB (once, at boot — v3.6 keeps it from blocking the MCP connection).

## Contract changes

- `embed()` on an idle gate loads and waits instead of rejecting. Rejection is for missing files, a failed load, or the bounded wait.
- `model_state` reads `idle` most of the time; that is normal. `ready_since` is empty while unloaded.
- `coordinator.eligible` no longer means "model loaded": it means reconciliation settled and the gate can serve.
- New env: `RAG_MEMORY_MODEL_IDLE_MS` (default 180000, 0 = keep resident).

## Definition of done

- Unit (fake loaders): `test/model-on-demand.test.mjs`, wired into `verify:engine`; 17 mutants of the new code all fail it.
- Real model, published-engine harness on a DB copy (`measure/e2e3.json`): boot leaves the model out (171 MB); from idle, 143 frozen queries give the same top-10 order as 6.4.4 for `hybridSearch` and `searchNodes`, all `hybrid`; idle 524-587 MB over 10 unload/reload cycles with no growth; reload-and-search 1.7-2.8 s; a write from idle is `embedded`.
- `npm test` passes on the final tree.

## Not measured

Windows; a cold OS file cache; several engines loading at once.
