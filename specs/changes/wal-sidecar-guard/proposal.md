# wal-sidecar-guard — keep a sync client from swapping the WAL out from under the engine

> 2026-09-25 · owner: "이번엔 확실히 고쳐보자. rag-memory-epf mcp코드를 고쳐야한다면 그것도 고치고"
> Design inputs (independent): framework hub `raw/implementation/2026-09-25-wal-fileprovider/`
> `fable-r1.md` (design) · `astra-r1.md` (checkpoint alternatives + replay counter-examples).

## Problem (measured, macOS + Google Drive for desktop)

- Every write fails with `SQLITE_IOERR` ("disk I/O error") until the engine restarts. Reads keep working.
- `lsof -p <engine>` shows the engine's `-wal` descriptor pointing at
  `~/Library/Application Support/FileProvider/<domain>/wharf/wharf/delete/<uuid>` (0 bytes), while
  the path `…/.memory/rag-memory.db-wal` is a **different inode**. The sync client moved the open
  file away and put a new one in its place. `lsof <path>` cannot see this (it matches the inode at
  the path), which is why it was first recorded as "the engine never opens the WAL".
- Timing: 10 s, ~2 min and ~3 min after engine start on three occasions — not "after a long idle".
  One engine attached is enough.
- `fileproviderctl evaluate …-wal`: `isUploaded = 1`, `isExcludedFromSync = 0`, content-modified
  time = swap time. The client treats the WAL as a synced item.
- Fresh test databases in the same folder did **not** reproduce it (TRUNCATE/PASSIVE/RESTART/none,
  2 KB–1 MB writes, 150–240 s, two independent harnesses). Truncating to 0 bytes alone is not the
  trigger. Leading hypothesis (unproven): the item has a remote counterpart (the file name has been
  synced before, including from another machine) and the client reconciles to it.
- Windows (same synced database) does not show it.

## Decision

1. **Exclude the sidecars from sync on macOS.** Set `com.apple.fileprovider.ignore#P = 1` on `-wal`
   and `-shm` (Google Drive honours it: `isExcludedFromSync = 1`, not uploaded). The attribute sits
   on the inode, and SQLite deletes both files when the last connection closes and recreates them
   on the next open, so the engine sets it after every open and whenever the `-wal` inode changes.
   Fail-open: a failure is logged, never fatal. Other platforms: no-op.
   This points the same way as the 6.3.1 invariant: a WAL that never leaves this machine cannot be
   replayed onto another machine's main file.
2. **Keep 6.3.1's `wal_checkpoint(TRUNCATE)` unchanged.** RESTART (± `journal_size_limit`) leaves
   valid frames that replay onto a foreign main file after SIGKILL — 3/3 and 3/3 in astra-r1 §3.
3. **Detect and recover.** The WAL keeper tick also compares the `-wal` inode at the path with the one
   recorded at open. Changed or missing → reopen the connection (and re-mark). A `SQLITE_IOERR*`
   from a checkpoint or a tool call also reopens. A tool call that failed with `SQLITE_IOERR*` is
   retried once **only for idempotent tools** (reads; `createEntities`, `createRelations`,
   `addObservations` dedup; `delete*`). Others get the error back after the reopen, so the caller
   can decide. A failed transaction is all-or-nothing (better-sqlite3 rolls back; SQLite discards the
   pager cache on IOERR), so a retry cannot double-apply a partial transaction; a multi-transaction
   tool is why the retry list is restricted.

## Review r2 (1_ fable) — applied

- F1 a failed reopen no longer leaves a silent dead engine: `dbDown` + backoff retry from the keeper
  tick (1 s → 60 s), and after 10 failed tries the engine exits so the host shows a failed server.
- F2 the inode watch needs 2 consecutive mismatching ticks, pauses 60 s after 3 reopens in 10 s,
  and turns itself off when the file system reports inode 0.
- F3 a reopen requested while a tool call runs waits for the call to end; a reconciliation cut by
  a reopen (or by an I/O error) goes back to `pending` and is rerun after the reopen.
- F4 before closing the old handle the engine tries one `wal_checkpoint(TRUNCATE)` on it (frames
  still readable go to the main file). **Known limit**: writes acknowledged in the last ≤1 s
  before a swap can be lost if the old file is no longer readable. The reopen log carries
  `walsz-before=` so the size of that window is on record.
- F5 no reopen once shutting down (the signal handler sets the flag before its checkpoint).
- F6 `deleteObservations` and `deleteDocuments` are not retried (a retry reports 0 deleted).
  A retried `createEntities` reports `created:false` for entities the first attempt wrote.
- F7 the storm test no longer depends on wall-clock speed; new tests for every path above.
- F8 `-shm` is watched as well.

## Review r3 (1_ fable recheck) — applied

- N1 the 10th failed reopen calls `onFatal` = main()'s full shutdown (transport first), so the
  process really ends; without main() it falls back to `shutdownAll()` + `process.exit`.
- N2 a reconciliation cut by a reconnect reruns itself on the new handle (at most 3 times, then
  `failed`); with no handle the engine starts it after the reopen.
- N3 the salvage checkpoint runs with `busy_timeout = 0`.
- N4 an I/O error reopens even inside the storm window (only the retry is withheld); calls hit by
  one swap share one reopen (a call whose handle was already replaced just retries).
- N5 `retryOpen()` does nothing once shutting down. N6 the chmod test is skipped for root.

## Not in this change

- Moving the database out of the synced folder, or `journal_mode=DELETE`/`PERSIST` (astra-r1 §4:
  a hot rollback journal attached to a foreign main changed committed data with `integrity_check ok`).
- Two machines running engines on one file at the same time (Decision 52) — still unsafe.
- Proving *why* the client swaps the file. The attribute removes the file from the client's view;
  the acceptance test is the live database (below), not a synthetic reproduction.

## Contract — done means

1. darwin: after a write, `-wal` and `-shm` carry the attribute; after the `-wal` is replaced at its
   path, the engine logs `db reopened (reason=wal-inode-changed…)`, re-marks the new file, and the
   next write lands in the main file.
2. `runWithIoRecovery`: idempotent tool + one IOERR → success, one reopen. Non-idempotent → the IOERR
   is returned, one reopen. Three reopens inside 10 s → no retry, error returned.
3. `test/wal-exit.test.mjs` unchanged and passing (TRUNCATE contract).
4. New tests fail before the change.
5. Live acceptance (framework hub, macOS): with marked sidecars the engine keeps the same `-wal`
   inode for ≥ 15 min of use; the unmarked baseline was swapped within 10 s–3 min (3/3).
