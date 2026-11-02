// vec0 slot state (specs/changes/vec-slot-reuse).
//
// sqlite-vec 0.1.x stores each vector in a 1,024-slot chunk (`<t>_chunks`: validity bitmap, size) and
// maps rowid -> (chunk_id, chunk_offset) in `<t>_rowids`. Two facts drive this file (measured
// 2026-11-02, sqlite-vec 0.1.7):
//   - a new row goes only into a free slot of the LATEST chunk; a slot freed in an older chunk is never
//     reused, so DELETE + INSERT of the same rowid leaks one slot whenever the row is not in the latest
//     chunk. UPDATE writes the same slot.
//   - a row can be present in `<t>_rowids` with its validity bit at 0. KNN does not see it, a plain
//     `JOIN <t> ON rowid` does, and UPDATE on it succeeds but leaves the bit at 0. DELETE of it is refused
//     ("validity bit is not set") whenever no higher bit in the same validity byte is set — the 0.1.7 check
//     is `!(byte >> (offset % 8))`, not a single-bit test — so only a rebuild removes it reliably.
// A position that cannot be resolved (chunk missing, offset outside the chunk, NULL fields) is not
// "invalid" and not "valid": it is reported as VecSlotError so nobody silently re-classifies it.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export type VecTable = 'chunks' | 'entity_embeddings';
export type SlotState = 'valid' | 'invalid' | 'shared' | 'absent';

const TABLES: ReadonlySet<string> = new Set(['chunks', 'entity_embeddings']);

export class VecSlotError extends Error {
  constructor(message: string) { super(message); this.name = 'VecSlotError'; }
}

function assertTable(table: string): asserts table is VecTable {
  if (!TABLES.has(table)) throw new VecSlotError(`not a vec0 table: ${table}`);
}

// One bit test, shared by the JS path and the SQL function below.
export function bitIsSet(validity: unknown, offset: unknown, size: unknown): boolean {
  if (!(validity instanceof Uint8Array) || typeof offset !== 'number' && typeof offset !== 'bigint'
      || typeof size !== 'number' && typeof size !== 'bigint') {
    throw new VecSlotError(`unresolvable vec0 slot (validity ${validity === null ? 'NULL' : typeof validity}, offset ${offset}, size ${size})`);
  }
  const off = Number(offset), sz = Number(size);
  // Every value must be an exact non-negative integer and agree with the bitmap; no 32-bit `>>` (it wraps).
  if (!Number.isSafeInteger(sz) || sz <= 0 || sz > validity.length * 8) {
    throw new VecSlotError(`vec0 chunk size ${String(size)} does not fit its ${validity.length}-byte bitmap`);
  }
  if (!Number.isSafeInteger(off) || off < 0 || off >= sz || BigInt(off) !== BigInt(offset as number | bigint)) {
    throw new VecSlotError(`vec0 slot offset ${String(offset)} outside chunk (size ${sz}, bitmap ${validity.length} bytes)`);
  }
  const byte = Math.floor(off / 8);
  return ((validity[byte] >> (off % 8)) & 1) === 1;
}

export function slotState(db: Database.Database, table: VecTable, rowid: number | bigint): SlotState {
  assertTable(table);
  const r = db.prepare(`SELECT chunk_id, chunk_offset FROM ${table}_rowids WHERE rowid = ?`).safeIntegers(true).get(BigInt(rowid)) as
    { chunk_id: bigint | null; chunk_offset: bigint | null } | undefined;
  if (!r) return 'absent';
  if (r.chunk_id === null || r.chunk_offset === null) throw new VecSlotError(`${table}: rowid ${rowid} has no position`);
  const c = db.prepare(`SELECT size, validity FROM ${table}_chunks WHERE chunk_id = ?`).safeIntegers(true).get(r.chunk_id) as
    { size: bigint; validity: Buffer } | undefined;
  if (!c) throw new VecSlotError(`${table}: rowid ${rowid} points at missing chunk ${r.chunk_id}`);
  const bit = bitIsSet(c.validity, r.chunk_offset, c.size);
  // A validity-0 slot looks free to vec0, so a later insert can take it: two rowids then point at one slot
  // and neither owns it (r4 M1). That is not a searchable vector of this rowid.
  const owners = Number((db.prepare(`SELECT COUNT(*) c FROM ${table}_rowids WHERE chunk_id = ? AND chunk_offset = ?`)
    .safeIntegers(true).get(r.chunk_id, r.chunk_offset) as { c: bigint }).c);
  if (owners > 1) return 'shared';
  return bit ? 'valid' : 'invalid';
}

// Does chunk <chunkId> hold a validity-0 or shared row? Deleting the last valid row of such a chunk makes
// vec0 drop the chunk while those rows still point at it (r4 M3), so the delete repairs first.
function chunkHasAnomaly(db: Database.Database, table: VecTable, chunkId: bigint): boolean {
  const c = db.prepare(`SELECT size, validity FROM ${table}_chunks WHERE chunk_id = ?`).safeIntegers(true).get(chunkId) as
    { size: bigint; validity: Buffer } | undefined;
  if (!c) return true;
  const seen = new Set<string>();
  for (const r of db.prepare(`SELECT chunk_offset FROM ${table}_rowids WHERE chunk_id = ?`).safeIntegers(true).iterate(chunkId) as
       IterableIterator<{ chunk_offset: bigint }>) {
    const k = String(r.chunk_offset);
    if (seen.has(k) || !bitIsSet(c.validity, r.chunk_offset, c.size)) return true;
    seen.add(k);
  }
  return false;
}

// Rebuild <table> now, inside the caller's transaction (a savepoint when one is open), keeping exactly the
// rows that own a valid slot. Used when a write or delete meets an anomalous slot, so no ordinary operation
// ever runs against a validity-0 or shared slot (r4 M1·M3). Costs one rebuild (measured 0.44 s for 5,600).
// Not forced (r5 M2): the same reason/cap as the idle rebuild apply. Above the live-vector cap the caller's
// transaction rolls back with a "maintenance needed" error instead of an unbounded rebuild inside a tool call.
function repairInline(db: Database.Database, table: VecTable): void {
  const r = rebuildVecTable(db, table);
  if (r.status === 'not-needed') return;
  if (r.status !== 'rebuilt') {
    throw new VecSlotError(`${table}: inline repair did not complete (${r.status}${r.error ? `: ${r.error}` : ''})` +
      (r.status === 'over-cap' ? ' — run the maintenance rebuild (scripts/rag-maintenance/compact-vectors.mjs)' : ''));
  }
  console.error(`🧹 vec0 ${table} repaired inline: dropped validity-0 ${r.before?.invalid ?? 0}, shared ${r.before?.aliased ?? 0}, ${r.ms} ms`);
}

// Raised only if a slot is still not writable after an inline repair (should not happen; kept so callers
// that catch it stay correct).
export class InvalidSlotError extends VecSlotError {
  constructor(table: string, rowid: number | bigint) {
    super(`${table}: rowid ${rowid} has a validity-0 slot; it is repaired by the vector table rebuild`);
    this.name = 'InvalidSlotError';
  }
}

// The one same-rowid vector write. Caller owns the transaction (CAS + provenance stay in it).
//   valid            -> UPDATE (same slot, no leak)
//   absent           -> INSERT
//   invalid / shared -> inline repair first (UPDATE would stay invisible or overwrite another rowid's vector), then INSERT
export function writeVector(db: Database.Database, table: VecTable, rowid: number | bigint, embedding: Buffer): SlotState {
  let state = slotState(db, table, rowid);
  const id = BigInt(rowid);
  if (state === 'invalid' || state === 'shared') { repairInline(db, table); state = slotState(db, table, rowid); }
  if (state !== 'valid' && state !== 'absent') throw new InvalidSlotError(table, rowid);
  if (state === 'valid') db.prepare(`UPDATE ${table} SET embedding = ? WHERE rowid = ?`).run(embedding, id);
  else db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`).run(id, embedding);
  return state;
}

// The one single-row vector delete (vec-slot-reuse r3 M2 · r4 M3). Every engine delete goes through here:
//   valid             -> DELETE (after an inline repair if its chunk holds a validity-0 or shared row, so the
//                        delete can never leave rows pointing at a chunk vec0 dropped)
//   invalid / shared  -> inline repair (it drops the row; vec0 refuses to DELETE most validity-0 rows)
//   absent            -> nothing
// A position error raises VecSlotError (caller's transaction rolls back), never a silent skip.
export function deleteVector(db: Database.Database, table: VecTable, rowid: number | bigint): SlotState {
  let state = slotState(db, table, rowid);
  if (state === 'invalid' || state === 'shared') { repairInline(db, table); return state; }   // repair drops it
  if (state === 'valid') {
    const p = db.prepare(`SELECT chunk_id FROM ${table}_rowids WHERE rowid = ?`).safeIntegers(true).get(BigInt(rowid)) as { chunk_id: bigint };
    if (chunkHasAnomaly(db, table, p.chunk_id)) {
      repairInline(db, table);
      state = slotState(db, table, rowid);
      if (state !== 'valid') return state;
    }
    db.exec(`DELETE FROM ${table} WHERE rowid = ${BigInt(rowid).toString()}`);
  }
  return state;
}

// ---- D1c: one searchability predicate, usable from SQL --------------------------------------------
// Registered on every engine connection (openConnection). Given the chunk row the slot points at, it
// answers 1/0; a NULL chunk (LEFT JOIN miss), NULL offset or an out-of-range offset raises an error so
// a broken position is never counted as "no vector" or "has a vector".
export function registerVecSlotFunctions(db: Database.Database): void {
  db.function('vec_slot_valid', { deterministic: true, safeIntegers: true },
    (validity: unknown, offset: unknown, size: unknown) => (bitIsSet(validity, offset, size) ? 1 : 0));
}

// SQL fragment: "a searchable vector exists in <table> for rowid <expr>". LEFT JOIN keeps a _rowids row
// whose chunk is gone, so vec_slot_valid sees NULL and raises instead of the row silently vanishing.
export function searchableVectorSql(table: VecTable, rowidExpr: string): string {
  assertTable(table);
  // A slot shared by two rowids is owned by neither (r4 M1): not searchable for either.
  return `EXISTS (SELECT 1 FROM ${table}_rowids vr LEFT JOIN ${table}_chunks vc ON vc.chunk_id = vr.chunk_id
                  WHERE vr.rowid = ${rowidExpr} AND vec_slot_valid(vc.validity, vr.chunk_offset, vc.size) = 1
                    AND NOT EXISTS (SELECT 1 FROM ${table}_rowids vs WHERE vs.chunk_id = vr.chunk_id
                                     AND vs.chunk_offset = vr.chunk_offset AND vs.rowid <> vr.rowid))`;
}

export interface SlotSummary {
  table: VecTable;
  chunks: number;          // vec0 chunks
  chunkSize: number;       // slots per chunk (from the schema's chunks, 1024 by default)
  slots: number;           // chunks × size
  valid: number;           // searchable vectors
  invalid: number;         // _rowids rows whose validity bit is 0 (not the same as empty slots)
  aliased: number;         // _rowids rows that share one slot with another rowid (not counted in valid/invalid)
  empty: number;           // slots - valid - invalid
  reclaimable: number;     // chunks that a rebuild removes = chunks - ceil(valid / chunkSize)
  reclaimableBytes: number;
  rewriteBytes: number;    // valid × dims × 4
}

export function slotSummary(db: Database.Database, table: VecTable, dims = 1024): SlotSummary {
  assertTable(table);
  const chunks = db.prepare(`SELECT chunk_id, size, validity FROM ${table}_chunks`).safeIntegers(true).all() as
    Array<{ chunk_id: bigint; size: bigint; validity: Buffer }>;
  const byId = new Map(chunks.map(c => [c.chunk_id, c]));
  let valid = 0, invalid = 0, slots = 0, chunkSize = 0;
  for (const c of chunks) { slots += Number(c.size); chunkSize = Math.max(chunkSize, Number(c.size)); }
  // valid = rows that alone own a slot whose bit is set · invalid = bit 0 · aliased = rows sharing a slot
  // (neither owns it; counted only here) · empty = slots no row owns validly.
  const rows = db.prepare(`SELECT rowid, chunk_id, chunk_offset FROM ${table}_rowids`).safeIntegers(true).all() as
       Array<{ rowid: bigint; chunk_id: bigint | null; chunk_offset: bigint | null }>;
  const perSlot = new Map<string, number>();
  for (const r of rows) {
    const c = r.chunk_id === null ? undefined : byId.get(r.chunk_id);
    if (!c) throw new VecSlotError(`${table}: rowid ${r.rowid} points at missing chunk ${r.chunk_id}`);
    const key = `${r.chunk_id}:${r.chunk_offset}`;
    perSlot.set(key, (perSlot.get(key) ?? 0) + 1);
  }
  // Every position is validated first (r5 M1): sharing a slot is no evidence that the slot is a real one.
  const bits = rows.map(r => bitIsSet(byId.get(r.chunk_id!)!.validity, r.chunk_offset, byId.get(r.chunk_id!)!.size));
  let aliased = 0;
  rows.forEach((r, i) => {
    if (perSlot.get(`${r.chunk_id}:${r.chunk_offset}`)! > 1) { aliased++; return; }
    if (bits[i]) valid++; else invalid++;
  });
  const size = chunkSize || 1024;
  const reclaimable = Math.max(0, chunks.length - Math.ceil(valid / size));
  return { table, chunks: chunks.length, chunkSize: size, slots, valid, invalid, aliased, empty: Math.max(0, slots - valid),
    reclaimable, reclaimableBytes: reclaimable * size * dims * 4, rewriteBytes: valid * dims * 4 };
}

// ---- D1b: verified rebuild ------------------------------------------------------------------------
export interface RebuildPolicy { minChunks: number; maxLive: number }
// maxLive: the automatic path holds the write lock for the whole rebuild. Measured 2026-11-02 (Mac, load
// ~4, complete function incl. full read-back): see specs/changes/vec-slot-reuse/proposal.md. Above the cap
// the rebuild is left to the owner-run maintenance script and stats shows due = 'over-cap'.
export const DEFAULT_REBUILD_POLICY: RebuildPolicy = { minChunks: 8, maxLive: 20_000 };

// Why a rebuild is (not) due. Repair (validity-0 rows present) does not need the saving threshold:
// sqlite-vec 0.1.7 refuses to DELETE such a row whenever no higher bit in its byte is set, so the
// rebuild is the only path that removes it (measured 2026-11-02, probe/delete_matrix.cjs).
export function rebuildReason(s: SlotSummary, policy: RebuildPolicy = DEFAULT_REBUILD_POLICY): string | null {
  if (s.valid > policy.maxLive) return null;
  if (s.invalid > 0 || s.aliased > 0) return 'repair';
  if (s.reclaimable >= policy.minChunks && s.reclaimable * s.chunkSize >= s.valid) return 'reclaim';
  return null;
}

// Test hooks: throw at a step, or change one re-inserted vector so the pre-commit verification must catch it.
export type RebuildFault = 'after-drop' | 'after-create' | 'after-partial' | 'corrupt-one';
export interface RebuildResult {
  table: VecTable;
  status: 'rebuilt' | 'not-needed' | 'busy' | 'position-error' | 'over-cap' | 'failed';
  reason?: string;
  before?: SlotSummary;
  after?: SlotSummary;
  ms: number;
  error?: string;
}

// Order-independent digest of (rowid, vector bytes) pairs: per-row sha256, sorted, hashed. Lets the copy
// and the read-back both use one full scan instead of a per-rowid lookup (measured 2026-11-02: the
// per-rowid version took 15.1 s / +625 MB RSS for 60,000 vectors).
class RowDigest {
  private parts: string[] = [];
  add(id: bigint | number, buf: Buffer): void {
    this.parts.push(createHash('sha256').update(String(id)).update(':').update(buf).digest('hex'));
  }
  get count(): number { return this.parts.length; }
  hex(): string { return createHash('sha256').update(this.parts.sort().join('\n')).digest('hex'); }
}

// Rebuild <table> keeping exactly its searchable (rowid, vector) pairs. Called on its own: one BEGIN IMMEDIATE
// transaction. Called inside an open transaction (inline repair): a savepoint of the caller's transaction;
// busy_timeout is 0 for the attempt (another writer means "skip now", not "wait 5 s") and restored after.
// Everything is re-checked inside the transaction because another engine may have rebuilt already.
// The table is re-created from its own CREATE statement in sqlite_master. Before commit: valid count,
// invalid = 0 and the full rowid -> vector-bytes digest must match, else the transaction rolls back.
export function rebuildVecTable(db: Database.Database, table: VecTable,
  opts: { policy?: RebuildPolicy; force?: boolean; fault?: RebuildFault; dims?: number } = {}): RebuildResult {
  assertTable(table);
  const t0 = Date.now();
  const policy = opts.policy ?? DEFAULT_REBUILD_POLICY;
  const prevBusy = Number(db.pragma('busy_timeout', { simple: true }));
  const prevCache = Number(db.pragma('cache_size', { simple: true }));
  db.pragma('busy_timeout = 0');
  try {
    return db.transaction((): RebuildResult => {
      let before: SlotSummary;
      try { before = slotSummary(db, table, opts.dims); }
      catch (e) { if (e instanceof VecSlotError) return { table, status: 'position-error', error: e.message, ms: Date.now() - t0 }; throw e; }
      if (before.valid > policy.maxLive && !opts.force) return { table, status: 'over-cap', before, ms: Date.now() - t0 };
      const reason = opts.force ? 'forced' : rebuildReason(before, policy);
      if (!reason) return { table, status: 'not-needed', before, ms: Date.now() - t0 };
      // The read-back below scans pages this transaction just wrote. With the page cache smaller than the
      // rewrite they spill and are re-read from disk: 20,000 vectors took 1.57 s to read back at the engine's
      // 32 MB cache vs 0.28 s at 200 MB (measured 2026-11-02). Size the cache to the rewrite for this call.
      const wantKiB = Math.ceil(before.rewriteBytes * 1.25 / 1024) + 16_384;
      if (prevCache < 0 ? wantKiB > -prevCache : true) db.pragma(`cache_size = -${wantKiB}`);
      const ddlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined;
      if (!ddlRow?.sql) throw new VecSlotError(`${table}: no CREATE statement in sqlite_master`);
      // Keep only searchable rows: read positions, test bits, copy those vectors.
      // rowids are read as BigInt end to end (r3 M1: a Number round-trip rewrote 2^53+1 as 2^53).
      const chunkRows = db.prepare(`SELECT chunk_id, size, validity FROM ${table}_chunks`).safeIntegers(true).all() as Array<{ chunk_id: bigint; size: bigint; validity: Buffer }>;
      const byId = new Map(chunkRows.map(c => [c.chunk_id, c]));
      // Keep valid rows that own their slot alone. A validity-0 row's slot looks free to vec0, so a later
      // insert can take it and two rowids then point at one slot (seen 2026-11-02): which vector belongs to
      // the older rowid is unknowable, so every rowid of a shared slot is dropped and re-embedded later.
      const rowsAll = db.prepare(`SELECT rowid, chunk_id, chunk_offset FROM ${table}_rowids`).safeIntegers(true).all() as
           Array<{ rowid: bigint; chunk_id: bigint; chunk_offset: bigint }>;
      const owners = new Map<string, number>();
      for (const r of rowsAll) { const k = `${r.chunk_id}:${r.chunk_offset}`; owners.set(k, (owners.get(k) ?? 0) + 1); }
      const validIds = new Set<bigint>();
      for (const r of rowsAll) {
        const c = byId.get(r.chunk_id);
        if (!c) throw new VecSlotError(`${table}: rowid ${r.rowid} points at missing chunk ${r.chunk_id}`);
        const bit = bitIsSet(c.validity, r.chunk_offset, c.size);   // position validated before sharing (r5 M1)
        if (owners.get(`${r.chunk_id}:${r.chunk_offset}`)! > 1) continue;
        if (bit) validIds.add(r.rowid);
      }
      const keep: Array<[bigint, Buffer]> = [];
      const wantD = new RowDigest();
      for (const v of db.prepare(`SELECT rowid, embedding FROM ${table}`).safeIntegers(true).iterate() as IterableIterator<{ rowid: bigint; embedding: Buffer }>) {
        if (!validIds.has(v.rowid)) continue;
        const buf = Buffer.from(v.embedding);
        keep.push([v.rowid, buf]);
        wantD.add(v.rowid, buf);
      }
      if (keep.length !== validIds.size) {
        throw new VecSlotError(`${table}: full scan returned ${keep.length} of ${validIds.size} valid vectors`);
      }
      const want = wantD.hex();
      db.exec(`DROP TABLE ${table}`);
      if (opts.fault === 'after-drop') throw new Error('fault injection: after-drop');
      db.exec(ddlRow.sql);
      if (opts.fault === 'after-create') throw new Error('fault injection: after-create');
      const ins = db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`);
      keep.forEach(([id, buf], i) => {
        if (opts.fault === 'after-partial' && i === Math.floor(keep.length / 2)) throw new Error('fault injection: after-partial');
        if (opts.fault === 'corrupt-one' && i === 0) { const bad = Buffer.from(buf); bad.writeFloatLE(bad.readFloatLE(0) + 1, 0); ins.run(id, bad); return; }
        ins.run(id, buf);
      });
      const after = slotSummary(db, table, opts.dims);
      const gotD = new RowDigest();
      for (const v of db.prepare(`SELECT rowid, embedding FROM ${table}`).safeIntegers(true).iterate() as IterableIterator<{ rowid: bigint; embedding: Buffer }>) {
        gotD.add(v.rowid, Buffer.from(v.embedding));
      }
      if (after.valid !== validIds.size || after.invalid !== 0 || after.aliased !== 0 || gotD.count !== wantD.count || gotD.hex() !== want) {
        throw new VecSlotError(`${table}: rebuild verification failed (kept ${validIds.size}, valid after ${after.valid}, invalid ${after.invalid}, aliased ${after.aliased})`);
      }
      return { table, status: 'rebuilt', reason, before, after, ms: Date.now() - t0 };
    }).immediate();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return { table, status: 'busy', error: String((e as Error).message), ms: Date.now() - t0 };
    return { table, status: 'failed', error: String((e as Error).message), ms: Date.now() - t0 };
  } finally {
    db.pragma(`busy_timeout = ${prevBusy}`);
    db.pragma(`cache_size = ${prevCache}`);
  }
}
