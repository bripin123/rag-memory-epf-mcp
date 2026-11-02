# vec-slot-reuse — stop vec0 slot leaks, reclaim them when idle, and count only searchable vectors

Branch: `feat/write-seq-signal` (ships in the same release as the write-seq signal, owner decision 2026-11-02).
Decision record (hub): `raw/advisor/2026-11-02-s252-dbcompact/2_-pane-s252.txt` D1a·D1b·D1c (2_ r2·r3).

## Problem (measured)

- sqlite-vec 0.1.7 `vec0` puts a new row only into a free slot of the **latest** 1,024-slot chunk. A slot freed
  in an older chunk is never reused; a chunk disappears only when every slot in it is deleted. The hub DB had
  84 chunks = 86,016 slots for 5,578 live chunk vectors (93.5% empty, 337 of 439 MB). (s252 `probe/vecprobe2.cjs`)
- Holes come from (a) document re-sync (old chunk rows deleted, new rows get new rowids), (b) re-embedding the
  same rowid as DELETE + INSERT, (c) entity re-embed as DELETE + INSERT with a **new** rowid, (d) real deletes.
- `UPDATE … SET embedding` on a valid row writes the same slot (s252 `probe/vecprobe3.cjs`, s253 `invalid_row.cjs` U1).
- A row present in `<t>_rowids` whose validity bit is 0 is invisible to KNN. `UPDATE` on it succeeds but leaves the
  bit at 0 — still invisible (s253 `invalid_row.cjs` U2·D). `DELETE` of it is refused ("validity bit is not set")
  whenever no higher bit in the same validity byte is set: the 0.1.7 check (`vec0Update_Delete_ClearValidity`) is
  `!(byte >> (offset % 8))`, not a single-bit test (s253 `delete_matrix.cjs`: refused for the top set bit, the last
  bit of a byte and an all-zero byte; accepted only with a higher bit set). So DELETE + INSERT is not a repair.
- When the last valid row of a chunk is deleted, vec0 drops the chunk even if validity-0 rows still point at it,
  leaving `_rowids` entries with no chunk (seen in s253 test setup).
- Coverage, backfill target selection, sanitize and reconciliation decide "has a vector" with
  `JOIN <t> v ON v.rowid = m.rowid` / `rowid IN (SELECT rowid FROM <t>)`, which is true for a validity-0 row. The
  hub had 5 live entities with validity 0 that coverage counted as embedded (`src/backfillCoordinator.ts:93·118·119·488·531`).
- Rebuild cost (s253 `probe/rebuild_cost.cjs`, file DB, WAL, one transaction, Mac load ~3):

  | live vectors | chunks before→after | rebuild | WAL growth | pages freed |
  |---|---|---|---|---|
  | 5,600 (93% empty) | 83→6 | 0.38 s | 25 MB | 310 MB |
  | 5,600 (50% empty) | 11→6 | 0.28 s | 24 MB | 20 MB |
  | 20,000 | 79→20 | 1.0 s | 81 MB | 238 MB |
  | 50,000 | 98→49 | 2.5 s | 199 MB | 197 MB |

  Cost grows with **live** vectors (~0.05 s per 1,000; WAL ≈ live × 4 KiB). Saving = reclaimable chunks × 4 MiB.
  Without VACUUM the file does not shrink; freed pages go to the freelist and are reused by later writes.
- The complete function (copy + full read-back verification, s253 `cap_measure_eng.mjs`, engine cache 32 MB, load ~4.6)
  first took 15.1 s for 60,000: the read-back of pages the transaction had just written spilled out of the page cache
  (phase timing: read-back 1.57 s at 32 MB vs 0.28 s at 200 MB for 20,000). With the cache sized to the rewrite for the
  call: 5,600 = 0.44 s · +66 MB RSS; 20,000 = 1.17 s · +270 MB; 60,000 = 3.58 s · +770 MB. → automatic cap 20,000 per table.

## Scope challenge

1. Reuse: the slot map logic exists in hub `scripts/rag-maintenance/compact-vectors.mjs` (`slotMap`, `rebuild`). The
   engine gets one implementation; the hub script imports it after release (no second algorithm).
2. Minimum: no schema change, no new tool, no change to deletes or to document re-sync row correspondence.
3. Complexity: files = `index.ts`, `src/backfillCoordinator.ts`, one new `src/vecSlots.ts`, tests. No new class.
4. Built-in: sqlite-vec has no compaction or slot-reuse command (0.1.7 · 0.1.9 same in s252 probe).
5. Tests: every changed write site and predicate gets a failing test first.

## Design

- **D1a — rewrite in place.** Same-rowid re-embed sites (`writeKgVectorIfCurrent`, `reembedChunkByRowid`, the bulk
  chunk embed at `index.ts:3230`, entity re-embed at `index.ts:2407`) call one helper `writeVector(db, table, rowid, buf)`:
  valid slot → `UPDATE`; no `_rowids` row → `INSERT`; `_rowids` row with validity 0 → `InvalidSlotError` (nothing written,
  the caller's transaction rolls back) and a repair rebuild is requested. Entity re-embed keeps its metadata rowid and updates the metadata row in place. CAS and
  provenance stay in the same transaction. Real deletes (`src/observations/projection.ts:71`, document re-sync,
  `deleteRelations`, invalidation) are not touched.
- **D1c — one validity predicate.** `src/vecSlots.ts` registers a deterministic SQL function on the engine connection
  (`vec_slot_valid(validity, offset, size)`) and exposes a SQL fragment "searchable vector exists for m.rowid in <t>"
  joining `<t>_rowids` and `<t>_chunks`. An out-of-range offset or a missing chunk raises an error (never read as
  validity 0). coverage, countNullWithVector, countRepairables, sanitize, reconcileEntities/Chunks and the backfill
  target scan all use it. A newly found validity-0 row becomes a backfill target (vector re-embedded, chunk_metadata
  text kept) and invalidates the coverage snapshot, also when reconciliation already reached n/a.
  Final contract (after 2_ r3 REVISE):
  - **No engine path DELETEs or INSERTs over a validity-0 row.** Every single-row vector delete goes through
    `deleteVector` (valid → DELETE · validity 0 → left for the rebuild · absent → nothing); every same-rowid write through
    `writeVector`. This covers invalidation, deleteEntities, document re-sync, KG chunk regeneration, projection,
    replace-import, sanitize and reconciliation. A new chunk vector that meets a leftover validity-0 row at its rowid
    stays missing and requests a repair.
  - **Searchable** (`searchableVectorSql`) decides coverage, the backfill scan (`has_vec`/`has_row`: validity-0 rows are
    skipped, never attempted, and request a repair), NULL-provenance reconciliation and the old-profile/orphan sanitize
    selections. Row presence (`_rowids`) decides "is there still a vector row" (stamped-but-vectorless normalization).
  - **Entity metadata is normalized to missing, not deleted**, when its vector row is gone (sanitize step 2, old profile):
    the rowid is kept, so the backfill re-inserts at the same rowid, also after a restart between repair and backfill.
  - **Shared slots**: a validity-0 slot looks free to vec0, so a later insert can take it and two rowids then point at one
    slot (seen in the s253 tests). Neither row owns it: `slotState` = `shared`, not searchable, not counted as valid
    (`slotSummary.aliased`); the repair rebuild drops every rowid of a shared slot and the backfill re-embeds both.
  - **Inline repair (2_ r4)**: `writeVector` / `deleteVector` that meet a validity-0 or shared slot, or a delete whose
    chunk holds one (vec0 drops a chunk with its last valid row and would orphan those positions), first run the verified
    rebuild inside the caller's transaction (savepoint), then do the ordinary write/delete. So no ordinary operation runs
    against an anomalous slot; the idle rebuild covers anomalies no write touches.
  - **New entity rowids** are allocated past both `entity_embedding_metadata` and `entity_embeddings_rowids` (explicit
    rowid, same transaction), because kept unstamped metadata rows reserve their rowid.
  - A slot map error holds only that table's phase and is reported per table (coverage `error` with `missing: null`,
    `vector_slots.<table>.error`, rebuild `position-error`). It is not auto-repaired.
  - The coverage snapshot is invalidated whenever a scan sees a validity-0 row or a slot-map error appears/clears.
  - rowids are BigInt end to end in summary/rebuild (2^53+1 kept); `bitIsSet` rejects non-integer, non-finite, oversize
    and out-of-range values (no 32-bit shifts).
- **D1b — idle rebuild.** `rebuildVecTable(db, table)` = inside one `BEGIN IMMEDIATE` transaction: recompute the slot
  map (abort on any position error), copy live (rowid, vector) for valid slots, `DROP`, re-create with the exact DDL from
  `sqlite_master`, re-insert with the same rowids, check counts and a self-hit sample before commit. No VACUUM.
  Runs from the existing WAL keeper tick only when: no tool call in flight, no backfill scan, no reconciliation, last
  tool call and last own write ≥ 60 s ago, at most every 10 min (a repair request skips the 10-min wait), and the
  reason holds **inside** the transaction (another engine may have done it). Reason = `repair` (any validity-0 row) or
  `reclaim` (reclaimable chunks R ≥ 8 and R × chunk size ≥ live). busy_timeout is 0 for the attempt (BUSY = skip now)
  and the page cache is sized to the rewrite; both are restored. "Busy" includes the whole reconciliation pass
  (sanitize batches too). A repair request skips the 10-min wait only once (when newer than the last check); a busy,
  failed or over-cap attempt waits for the normal interval. Verification before commit = valid count, no
  validity-0 row, and an order-independent digest of every (rowid, vector bytes) pair read back by full scan.
  A rebuild that dropped validity-0 rows kicks the backfill, which INSERTs them back at their own rowid.
  Stats `server.vector_slots` = per table slots/valid/invalid/empty/reclaimable/due and this process's last attempt.

## Contract (Definition of Done)

1. Re-embedding a valid row (chunk, KG chunk, entity) does not add a slot: `<t>_chunks` slot count and the row's
   (chunk_id, offset) are unchanged; KNN self-hit holds.
2. Re-embedding a validity-0 row makes it searchable (self-hit) and leaves no validity-0 row behind.
3. Entity re-embed keeps the metadata rowid; observations/CAS/provenance behaviour unchanged (existing tests green).
4. coverage reports a validity-0 row as missing; backfill re-embeds it; `missing` returns to 0 afterwards.
5. A position error in the slot map surfaces as an error, not as "missing" or "valid".
6. Idle rebuild: chunks shrink to ceil(live/1024) (+ partial tail), every rowid and vector byte preserved, FTS and
   metadata untouched; fault injection after DROP / after CREATE / after partial re-insert rolls back to the original
   state (rowids, bytes, KNN); a second connection holding a write lock makes the rebuild skip, not fail; a reopened
   connection sees the rebuilt table.
7. `npm test` (verify:engine) exit 0 without a pipe; write-seq tests stay green.

## Tests

`test/vec-slot-reuse.test.mjs` (Contract 1–4, incl. bulk embedChunks and KG write-back) · `test/vec-rebuild.test.mjs`
(Contract 5–6, run conditions, stats) · `test/vec-slot-invalid.test.mjs` (2_ r3 counterexamples: strict positions, 2^53+1
rowid, sanitize/reconcile around validity-0 rows, restart between repair and backfill, shared slot, coverage cache,
busy during sanitize, no retry per tick, deletes next to a validity-0 row).
Mutation check (s253 `probe/mutate.py`, 19 mutations of the built JS incl. reverting each r3 fix, unmutated control
green before and after): 19/19 caught (`probe/mutate-out11.txt`).

## Out of scope

- VACUUM in the automatic path (maintenance script keeps it, owner-run).
- Document re-sync reusing old rowids.
- Root cause of the 5 validity-0 rows (created 08-09 / 10-10; not reproduced by normal operations).
