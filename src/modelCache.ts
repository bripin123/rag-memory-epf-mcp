// v3.6 lite install (spec 2026-07-18 v5 §7): version-independent model cache.
// The transformers.js default cache lives INSIDE the package directory, which is
// npx-slot scoped — every engine version bump re-downloads ~1.2GB. This module
// resolves a user-level cache dir and provides a cross-process download lock so
// concurrent MCP servers on one machine never write the same model concurrently
// (transformers' FileCache.put is not atomic).
//
// Lock/marker keys use ONLY cache-artifact fields (model id, revision, dtype) —
// never retrieval config (spec §6c layer 1).

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function resolveModelCacheDir(
  env: Record<string, string | undefined>,
  platform: string,
  homedir: string
): string {
  if (env.RAG_MEMORY_MODEL_CACHE_DIR) return env.RAG_MEMORY_MODEL_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'rag-memory-epf-mcp');
  if (platform === 'darwin') return join(homedir, 'Library', 'Caches', 'rag-memory-epf-mcp');
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'rag-memory-epf-mcp');
  return join(homedir, '.cache', 'rag-memory-epf-mcp');
}

// mkdir -p + write probe. On failure the caller must transition the gate to
// `failed` — silently falling back to the package-internal cache is forbidden.
export function preflightCacheDir(dir: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function artifactKey(modelId: string, revision: string, dtype: string): string {
  return createHash('sha1').update(`${modelId}@${revision}#${dtype}`).digest('hex').slice(0, 12);
}

const STALE_LOCK_MS = 30 * 60_000;

export class ModelDownloadLock {
  readonly lockPath: string;
  readonly markerPath: string;
  private held = false;

  constructor(cacheDir: string, key: string) {
    this.lockPath = join(cacheDir, `.download-${key}.lock`);
    this.markerPath = join(cacheDir, `.complete-${key}`);
  }

  private tryAcquire(): boolean {
    try {
      writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
      this.held = true;
      return true;
    } catch {
      return false;
    }
  }

  // Stale = holder pid is dead or the lock is unreadable. A LIVE pid is never
  // reclaimed by age alone (beta B5): a slow 1.2GB download has no heartbeat,
  // so an mtime rule would mint a second concurrent owner — the exact failure
  // this lock exists to prevent. A hung-but-alive holder instead surfaces as a
  // waiter timeout -> gate 'failed' + backoff, with the lock path and holder
  // pid in the error so an operator can verify and remove it manually (the
  // recovery procedure lives in docs/UPDATING.md). No pid-reuse heuristic:
  // there is no portable process-start identity to compare against (beta 2R).
  private isStale(): boolean {
    try {
      const info = JSON.parse(readFileSync(this.lockPath, 'utf-8')) as { pid: number; startedAt: number };
      try { process.kill(info.pid, 0); } catch { return true; } // pid dead
      return false;
    } catch {
      return true; // unreadable lock = stale
    }
  }

  private holderPid(): number | null {
    try { return (JSON.parse(readFileSync(this.lockPath, 'utf-8')) as { pid: number }).pid; }
    catch { return null; }
  }

  // Corrupted-cache recovery (beta B5): a marker only proves a PAST verified
  // load. When a marker-holder ('ready' role) later fails to load, the caller
  // must invalidate the marker so the next attempt becomes a locked owner.
  invalidateMarker(): void {
    try { unlinkSync(this.markerPath); } catch { /* already gone */ }
  }

  // Returns 'owner' (caller must download, then markComplete + release) or
  // 'ready' (a completed, verified cache already exists). Async polling only —
  // never blocks the event loop (spec §7 / 3R M14).
  async acquireOrWait(opts: { pollMs?: number; timeoutMs: number; signal?: AbortSignal }): Promise<'owner' | 'ready'> {
    const poll = opts.pollMs ?? 500;
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      // Abort FIRST (beta 2R B5): a shutdown-aborted waiter must never become
      // an owner or report 'ready' and start a pipeline load.
      if (opts.signal?.aborted) throw new Error('model download lock wait aborted');
      if (existsSync(this.markerPath)) return 'ready';
      if (this.tryAcquire()) return 'owner';
      if (this.isStale()) {
        try { unlinkSync(this.lockPath); } catch { /* raced with another reclaimer */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`model download lock wait timed out — holder pid=${this.holderPid() ?? 'unknown'}, lock=${this.lockPath}. If that process is hung, verify and remove the lock file manually (see docs/UPDATING.md).`);
      }
      // Abortable sleep: shutdown does not have to ride out the poll interval.
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, poll);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }

  // Only call after a verified cache load — a memory-only load success without
  // durable cache files must NOT produce a marker (3R M14).
  markComplete(): void {
    const tmp = `${this.markerPath}.tmp.${process.pid}`;
    writeFileSync(tmp, new Date().toISOString());
    renameSync(tmp, this.markerPath);
  }

  release(): void {
    if (this.held) {
      try { unlinkSync(this.lockPath); } catch { /* already gone */ }
      this.held = false;
    }
  }
}

// Owner-side failure handling: partially downloaded model dirs are quarantined
// (renamed aside) rather than left in place, so the next attempt starts clean.
// transformers.js FileCache keys are `<org>/<model>/...` — the on-disk layout
// nests the model id's path segments under cacheDir (beta B5: a flattened
// `org_model` path would miss the real files entirely).
export function quarantinePartialCache(cacheDir: string, modelId: string): void {
  const dir = join(cacheDir, ...modelId.split('/'));
  if (existsSync(dir)) {
    try {
      renameSync(dir, `${dir}.quarantine.${Date.now()}`);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Retention (beta 2R B3): keep only the newest quarantine — repeated failures
  // must not accumulate 1.2GB directories.
  try {
    const parent = join(cacheDir, ...modelId.split('/').slice(0, -1));
    const leaf = modelId.split('/').pop() as string;
    const quarantines = readdirSync(parent)
      .filter(f => f.startsWith(`${leaf}.quarantine.`))
      .sort();
    for (const old of quarantines.slice(0, -1)) {
      rmSync(join(parent, old), { recursive: true, force: true });
    }
  } catch { /* parent may not exist */ }
}
