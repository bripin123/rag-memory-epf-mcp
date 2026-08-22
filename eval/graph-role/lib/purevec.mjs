// Pure ranking helper for the post-hoc pure-vector channel (run-purevec.mjs). No engine/DB import —
// the caller runs the raw vector SQL and hands us plain {chunk_id, distance} rows to order.
export function orderByDistance(rows) {
  return rows.slice().sort((a, b) => a.distance - b.distance || (a.chunk_id < b.chunk_id ? -1 : 1)).map(r => r.chunk_id);
}
