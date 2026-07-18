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

// Configuration incompatibility (e.g. a non-1024-dim custom model): retrying or
// quarantining the cache cannot fix it — the gate parks in terminal 'failed'
// with no reload schedule (beta 2R B3).
export class TerminalConfigError extends Error {
  readonly terminal = true;
  constructor(message: string) {
    super(message);
    this.name = 'TerminalConfigError';
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
  // Systemic-failure detector (beta 2R B4): DISTINCT failed inputs within the
  // current load epoch (cleared on successful load AND on any inference
  // success). Same-input retries are data-specific (poison row) and never
  // demote. `demotions` escalates the reload backoff across repeated
  // demote-reload cycles and only resets on a real inference success.
  private failedInputs = new Set<string>();
  private demotions = 0;
  private terminalFailure = false;
  readonly abort = new AbortController();        // loader passes this to lock waits / fetches
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
      this.failedInputs.clear();                  // fresh load epoch (beta 2R B4)
      this.readySince = new Date().toISOString();
      this.setState('ready');
      this.opts.onReady?.();
      this.pump();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.setState('failed');
      this.startPromise = null;
      if ((e as TerminalConfigError)?.terminal === true) {
        // Config incompatibility (beta 2R B3): retrying or quarantining cannot
        // fix it — no reload schedule; a restart with a fixed config is the
        // only recovery.
        this.terminalFailure = true;
        this.retryAt = undefined;
        console.error(`❌ embeddings disabled for this run (config): ${this.lastError}`);
        throw e;
      }
      this.scheduleRetry(this.attempt++);
      throw e;
    }
  }

  // Shared retry scheduler with jitter; escalation index picks the backoff slot.
  private scheduleRetry(escalation: number): void {
    if (this.shuttingDown || this.terminalFailure) return;
    const base = this.backoff[Math.min(escalation, this.backoff.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4)); // jitter ±20%
    this.retryAt = new Date(Date.now() + delay).toISOString();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start().catch(() => { /* surfaced via state, not rejection */ });
    }, delay);
    this.retryTimer.unref?.();
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
        this.failedInputs.clear();
        this.demotions = 0;                        // a real success resets escalation
        if (job.gen === this.generation) job.resolve(v);
        else job.reject(new Error('embedding discarded: gate shut down'));
      })
      .catch(e => {
        // Systemic-failure detection (beta 2R B4): 3 DISTINCT failed inputs in
        // this load epoch -> demote to failed + reload with ESCALATING backoff
        // (demotions counter survives reloads; only an inference success
        // resets it — so a persistently broken runtime backs off instead of
        // hot-looping). Same-input repeats (A→A) and A→B→A count 2 distinct.
        this.failedInputs.add(`${job.text}|${job.dims}|${job.isQuery}`);
        if (this.failedInputs.size >= 3 && this.state === 'ready' && !this.shuttingDown) {
          this.lastError = e instanceof Error ? e.message : String(e);
          this.embedFn = null;
          this.startPromise = null;
          this.failedInputs.clear();
          this.setState('failed');
          this.scheduleRetry(this.demotions++);
          for (const j of this.queue.splice(0)) j.reject(new GateNotReadyError('failed'));
        }
        job.reject(e);
      })
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }

  // Was the load still in flight when shutdown settled? (index.ts uses this to
  // decide whether a bounded exit is needed — see shutdownAll.)
  get loadInFlight(): boolean {
    return this.startPromise !== null && this.state !== 'ready' && this.state !== 'failed' && this.state !== 'disabled';
  }

  // Graceful shutdown (spec §3, beta B1): block new work, abort what we can
  // (lock waits via this.abort), discard in-flight inference results via the
  // generation token, clear retry timers, then wait (bounded) for BOTH the
  // current inference and an in-flight model load to settle.
  async shutdown(deadlineMs = 5000): Promise<void> {
    this.shuttingDown = true;
    this.generation++;
    this.abort.abort();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const j of this.queue.splice(0)) j.reject(new Error('gate shutdown'));
    const deadline = Date.now() + deadlineMs;
    if (this.startPromise) {
      const remaining = () => Math.max(0, deadline - Date.now());
      await Promise.race([
        this.startPromise.catch(() => { /* settled by failure is settled */ }),
        new Promise(r => setTimeout(r, remaining())),
      ]);
    }
    while (this.running && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
  }
}
