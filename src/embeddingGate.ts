// v3.6 lite install (spec 2026-07-18 v5 §3): EmbeddingGate owns the embedding
// model lifecycle — nothing else. State machine + single-flight load/retry +
// prioritized serial inference queue. It does NOT touch the DB, backfill
// policy, FTS SQL, or tool response shapes (A′ boundary).
//
// Consumers never read state and then call separately (TOCTOU): embed() decides
// and executes inside one boundary, rejecting with typed errors when the model
// is unavailable so each tool can honor its own not-ready contract.

export type ModelState = 'disabled' | 'idle' | 'loading' | 'downloading' | 'ready' | 'failed';
export type EmbedPriority = 'interactive' | 'bulk' | 'backfill';
export type EmbedFn = (text: string, dims: number, isQuery: boolean) => Promise<Float32Array>;

export class GateDisabledError extends Error {
  readonly code = 'EMBEDDINGS_DISABLED';
  readonly state = 'disabled';
  constructor() {
    super('Embeddings are disabled (RAG_MEMORY_EMBEDDINGS=off)');
    this.name = 'GateDisabledError';
  }
}

export class GateNotReadyError extends Error {
  readonly code = 'MODEL_NOT_READY';
  constructor(readonly state: ModelState, readonly retryAfterMs?: number) {
    super(`Embedding model not ready (state=${state})`);
    this.name = 'GateNotReadyError';
  }
}

const PRIO: Record<EmbedPriority, number> = { interactive: 0, bulk: 1, backfill: 2 };
const DEFAULT_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000];

interface Job {
  text: string;
  dims: number;
  isQuery: boolean;
  prio: number;
  seq: number;
  gen: number;
  resolve: (v: Float32Array) => void;
  reject: (e: unknown) => void;
}

export interface GateOptions {
  mode: 'lazy' | 'eager' | 'off';
  loadModel: () => Promise<EmbedFn>;
  onReady?: () => void;
  onStateChange?: (s: ModelState) => void;
  backoffMs?: number[];
}

export class EmbeddingGate {
  private state: ModelState;
  private embedFn: EmbedFn | null = null;
  private startPromise: Promise<void> | null = null;
  private queue: Job[] = [];
  private running = false;
  private seq = 0;
  private generation = 0;
  private shuttingDown = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readySince?: string;
  private lastError?: string;
  private retryAt?: string;
  private readonly backoff: number[];

  constructor(private readonly opts: GateOptions) {
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.state = opts.mode === 'off' ? 'disabled' : 'idle';
  }

  get status() {
    return { state: this.state, readySince: this.readySince, lastError: this.lastError, retryAt: this.retryAt };
  }
  get isReady() { return this.state === 'ready'; }
  get isDisabled() { return this.state === 'disabled'; }

  private setState(s: ModelState) {
    if (this.state !== s) {
      this.state = s;
      this.opts.onStateChange?.(s);
    }
  }

  // Single-flight: concurrent calls share one load; after a failure the next
  // scheduled retry (or explicit call) re-enters loadOnce.
  start(): Promise<void> {
    if (this.state === 'disabled' || this.shuttingDown) return Promise.resolve();
    if (!this.startPromise) this.startPromise = this.loadOnce();
    return this.startPromise;
  }

  // loading -> downloading is reported by the loader via markDownloading().
  markDownloading() {
    if (this.state === 'loading') this.setState('downloading');
  }

  private async loadOnce(): Promise<void> {
    this.setState('loading');
    try {
      this.embedFn = await this.opts.loadModel();
      this.attempt = 0;
      this.retryAt = undefined;
      this.lastError = undefined;
      this.readySince = new Date().toISOString();
      this.setState('ready');
      this.opts.onReady?.();
      this.pump();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      const base = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
      const delay = Math.round(base * (0.8 + Math.random() * 0.4)); // jitter ±20%
      this.attempt++;
      this.retryAt = new Date(Date.now() + delay).toISOString();
      this.setState('failed');
      this.startPromise = null;
      if (!this.shuttingDown) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.start().catch(() => { /* surfaced via state, not rejection */ });
        }, delay);
        this.retryTimer.unref?.();
      }
      throw e;
    }
  }

  embed(text: string, o: { dims?: number; isQuery?: boolean; priority: EmbedPriority }): Promise<Float32Array> {
    if (this.state === 'disabled') return Promise.reject(new GateDisabledError());
    if (this.shuttingDown) return Promise.reject(new GateNotReadyError(this.state));
    if (this.state !== 'ready') {
      const retryAfterMs = this.retryAt ? Math.max(0, Date.parse(this.retryAt) - Date.now()) : undefined;
      return Promise.reject(new GateNotReadyError(this.state, retryAfterMs));
    }
    return new Promise<Float32Array>((resolve, reject) => {
      this.queue.push({
        text, dims: o.dims ?? 1024, isQuery: o.isQuery ?? false,
        prio: PRIO[o.priority], seq: this.seq++, gen: this.generation, resolve, reject,
      });
      this.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running || !this.embedFn) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    void this.embedFn(job.text, job.dims, job.isQuery)
      .then(v => {
        if (job.gen === this.generation) job.resolve(v);
        else job.reject(new Error('embedding discarded: gate shut down'));
      })
      .catch(e => job.reject(e))
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }

  // Graceful shutdown (spec §3): block new work, discard in-flight results via
  // generation token, clear retry timers, wait (bounded) for the current
  // inference to settle. Never calls process.exit.
  async shutdown(deadlineMs = 5000): Promise<void> {
    this.shuttingDown = true;
    this.generation++;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const j of this.queue.splice(0)) j.reject(new Error('gate shutdown'));
    const deadline = Date.now() + deadlineMs;
    while (this.running && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
  }
}
