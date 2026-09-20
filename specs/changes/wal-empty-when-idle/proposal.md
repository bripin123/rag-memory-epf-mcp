# wal-empty-when-idle — the engine folds its own WAL

## Problem

A live database in a cloud-synced folder was corrupted twice (2026-09-17 WAL, 2026-09-19 main
file). A `-wal` that still holds frames after its process is gone gets replayed at the next open
against whatever main file is there by then — possibly one written by another machine. SQLite
does not check that a WAL belongs to the main file beside it.

## Measured (2026-09-20, macOS, node 24.12, engine 6.3.0)

| Exit path | 6.3.0 | How measured |
|---|---|---|
| SIGTERM / SIGINT / stdin EOF, single engine | clean | `test/wal-exit.test.mjs` `sigterm` |
| SIGHUP | **default signal death, WAL kept** | `sighup` |
| hard kill (SIGKILL / Windows TerminateProcess) | **WAL 749,872 B** | `hardkill` |
| clean SIGTERM while another engine has the file open | **WAL 753,992 B** | `not-last` |
| codex-cli 0.155.1 `/quit`, Ctrl+C | SIGTERM + stdin EOF, then SIGKILL after ~185 ms | signal-recording stand-in MCP server, 10 ms heartbeat, two runs each |

While running, a fresh 6.3.0 database is 4,096 B main + 663,352 B WAL: nothing is ever folded
before exit. With the fix the same database is 307,200 B main + 0 B WAL while running.

The codex grace was enough for an idle engine on macOS (both 6.3.0 and the fix left no sidecars
under real codex `/quit`). It is not a guarantee: the settle sequence allows up to 5 s + 5 s, and
on Windows there is no SIGTERM at all (session 105 measured codex leaving the WAL there).

## Options considered

1. **Add a SIGHUP handler only.** Closes one path. Leaves hard kill and not-last — the two that
   match the Windows measurement and the real four-engine setup. Rejected as insufficient.
2. **`journal_mode = DELETE`.** No WAL at all between transactions. But it changes the journal
   mode of every existing database, needs exclusive access to switch while several engines of
   mixed versions are attached, and makes writers block readers. A hot rollback journal left by a
   kill mid-transaction has the same foreign-main hazard, just in a narrower window. Not chosen;
   left for the owner as the heavier alternative.
3. **`SQLITE_FCNTL_PERSIST_WAL`.** Keeps the WAL file across close — the opposite of what is needed.
4. **Engine-driven `wal_checkpoint(TRUNCATE)` (chosen).** Tick every 1 s when `-wal` has bytes,
   ~200 ms after each tool call, synchronously first thing in the signal handler, and before
   `close()`. Covers every path above including the ones where no code can run at exit, because
   the invariant is held *before* exit. No schema change, no tool-surface change.

## Known limits

- A write in the last ~1 s before a hard kill can still be in the WAL. The window went from
  "the whole session" to about a second; it is not zero.
- TRUNCATE reports busy while another connection holds a read transaction; the tick retries.
  Long-running concurrent readers were not measured.
- Two machines running engines against the same synced file at the same time remains unsafe.
  This change does not address that and nothing inside one engine can.
- Windows: the test is written to run there (`hardkill` and `not-last` run, POSIX-signal paths
  print SKIPPED) but **has not been run on Windows yet**.

## Verification

`node test/wal-exit.test.mjs` (wired into `verify:engine`). Non-vacuous: fails 3 of 5 paths on 6.3.0.
