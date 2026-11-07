/**
 * vec0 tables (chunks · entity_embeddings) are created without `distance_metric`, so sqlite-vec returns the
 * default L2 distance. Embeddings are unit-normalized (`normalize: true`), so for unit vectors
 * ‖a − b‖² = 2 − 2·cos  →  cosine similarity = 1 − d²/2.
 * The earlier conversion 1 − d/2 treated the L2 value as a cosine distance: right − old = (d − d²)/2, so it
 * under-reported for d < 1 (cos > 0.5: cos 0.8 showed ≈0.684) and over-reported for d > 1 (orthogonal showed
 * ≈0.293 instead of 0 · cos 0.3 showed ≈0.408 and passed the 0.4 graph-seed threshold). Clamped to [0, 1].
 * Guarded by test/vec-similarity.test.mjs (also asserts the metric is still L2).
 */
export function l2ToCosineSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.min(1, Math.max(0, 1 - (distance * distance) / 2));
}

/**
 * The 6.3.2 score, kept ONLY for the legacy paths that are pinned byte-for-byte (engine commit 4ac3155 · test
 * graph-context-explain): hybridSearch with useGraph:true or summaries on, and the graph-seed `> 0.4` threshold of
 * explainGraphContext. It is the historical 1 − d/2 conversion of an L2 distance and is NOT a cosine similarity
 * (its 0.4 threshold equals a real cosine of about 0.28). Default search and searchNodes use l2ToCosineSimilarity.
 */
export function legacyL2AsCosineScore(distance: number): number {
  return Math.max(0, 1 - distance / 2);
}
