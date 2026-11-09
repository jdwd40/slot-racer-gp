// Durable delivery of finalized results to storage. A result the database cannot take right now (down, timing out) is written
// to a spool file on local disk (fsynced, then renamed into place) before the room is told 'pending', and retried until the
// database accepts it, including after a restart (the spool is drained at start). Storage is idempotent by raceId
// (server/results.ts), so a retry after a commit whose reply was lost, a second process, or a re-delivered file can never
// award twice. Each spool file carries the career scoring policy the room showed at the finish, and a replay stores exactly
// that policy, whatever the server is configured with by then.
//
// 'pending' is only ever reported for a result that is on disk. If the spool cannot be written (unwritable, full) or there is
// no spool directory (development), the result is held in memory, retried, reported 'unsaved' (it is lost if the process
// stops first) and the spool write is retried with every pass; once it succeeds the room is told 'pending'. docs/career.md.
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { makeScoring, type Scoring } from './career';
import { digestOf, type ResultEnvelope } from './envelope';
import type { Logger } from './log';
import { ResultConflict, type ConsumeResult, type ResultSink } from './results';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPOOL_FORMAT = 'slotrush-spool-1';

/** what a spool file holds: the untouched server envelope and the scoring policy its awards were shown with */
interface SpoolRecord { format: typeof SPOOL_FORMAT; scoring: { version: string; podium: number[] }; envelope: ResultEnvelope; }

interface Queued { e: Readonly<ResultEnvelope>; scoring: Scoring; /** written to the spool (survives a restart) */ durable: boolean; }

export interface DurableOpts {
  /** spool directory (production: /var/lib/slotrush-server/spool via systemd StateDirectory); null keeps the queue in memory */
  dir: string | null;
  log: Logger;
  /** policy for a result delivered without one (the room always passes the policy it showed); default makeScoring() */
  scoring?: Scoring;
  /** first retry delay; doubles up to maxRetryMs */
  retryMs?: number;
  maxRetryMs?: number;
}

export class DurableSink implements ResultSink {
  /** results waiting for storage, by raceId */
  private queue = new Map<string, Queued>();
  private timer: NodeJS.Timeout | null = null;
  private delay: number;
  private draining: Promise<void> | null = null;
  private stopped = false;
  private readonly scoring: Scoring;
  /**
   * Told when a queued result has moved on: stored (or found already stored) → 'saved'; refused as a conflict → 'failed';
   * a memory-only result finally written to the spool → 'pending'. Rooms update their notice.
   */
  onSettled: ((raceId: string, r: 'saved' | 'failed' | 'pending') => void) | null = null;

  constructor(private inner: ResultSink, private o: DurableOpts) {
    this.delay = o.retryMs ?? 2000;
    this.scoring = o.scoring ?? makeScoring();
  }

  /** results not stored yet (durable or not) */
  get pending(): number { return this.queue.size; }
  /** of those, the ones held only in memory: a stop now loses them */
  get unsaved(): number { let n = 0; for (const q of this.queue.values()) if (!q.durable) n++; return n; }

  async consume(e: Readonly<ResultEnvelope>, scoring: Scoring = this.scoring): Promise<ConsumeResult> {
    const had = this.queue.get(e.raceId);
    if (had) return had.durable ? 'queued' : 'unsaved';
    try {
      return await this.inner.consume(e, scoring);
    } catch (err) {
      if (err instanceof ResultConflict) throw err;
      this.o.log.error('result.store_failed', { race: e.raceId, error: String(err) });
      const q: Queued = { e, scoring, durable: false };
      this.queue.set(e.raceId, q);
      if (this.o.dir) await this.spool(q);
      else this.o.log.error('result.queued_memory', { race: e.raceId, note: 'no SLOTRUSH_SPOOL_DIR: lost if the process stops' });
      this.schedule();
      return q.durable ? 'queued' : 'unsaved';
    }
  }

  private file(raceId: string): string { return join(this.o.dir!, `${raceId}.json`); }

  /** Write one queued result to the spool; on success it is durable. A failure is logged and leaves it in memory only. */
  private async spool(q: Queued): Promise<boolean> {
    const rec: SpoolRecord = { format: SPOOL_FORMAT, scoring: { version: q.scoring.version, podium: [...q.scoring.podium] }, envelope: q.e as ResultEnvelope };
    const tmp = `${this.file(q.e.raceId)}.tmp`;
    try {
      await mkdir(this.o.dir!, { recursive: true, mode: 0o700 });
      const fh = await open(tmp, 'w', 0o600);
      try { await fh.writeFile(JSON.stringify(rec)); await fh.sync(); } finally { await fh.close(); }
      await rename(tmp, this.file(q.e.raceId));
      await this.syncDir();
      q.durable = true;
      this.o.log.warn('result.spooled', { race: q.e.raceId, scoring: q.scoring.version });
      return true;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      this.o.log.error('result.spool_failed', { race: q.e.raceId, error: String(err), note: 'held in memory only: lost if the process stops before storage is back' });
      return false;
    }
  }

  /** fsync the directory so the rename itself survives a crash */
  private async syncDir(): Promise<void> {
    const dh = await open(this.o.dir!, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  }

  private schedule(): void {
    if (this.timer || this.stopped || !this.queue.size) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, this.delay);
    this.timer.unref?.();
  }

  /** Load spooled results left by an earlier process, then try to store everything queued. */
  async start(): Promise<void> {
    if (this.o.dir) {
      let names: string[] = [];
      try { names = await readdir(this.o.dir); } catch { /* no spool yet */ }
      for (const n of names) {
        if (!n.endsWith('.json') || !UUID_RE.test(n.slice(0, -5))) continue;
        try {
          const q = this.parse(n.slice(0, -5), JSON.parse(await readFile(join(this.o.dir, n), 'utf8')));
          if (!q) { this.o.log.error('result.spool_corrupt', { file: n }); await rename(join(this.o.dir, n), join(this.o.dir, `${n}.bad`)); continue; }
          if (q.scoring.version !== this.scoring.version) this.o.log.info('result.spool_scoring', { race: q.e.raceId, scoring: q.scoring.version, configured: this.scoring.version });
          this.queue.set(q.e.raceId, q);
        } catch (err) { this.o.log.error('result.spool_unreadable', { file: n, error: String(err) }); }
      }
      if (this.queue.size) this.o.log.info('result.spool_loaded', { pending: this.queue.size });
    }
    await this.drain();
  }

  /** A spool file's record, or null if it is not one this server wrote (wrong format, edited envelope, invalid policy). */
  private parse(raceId: string, rec: unknown): Queued | null {
    const r = rec as Partial<SpoolRecord> | null;
    if (!r || r.format !== SPOOL_FORMAT || !r.envelope || !r.scoring || !Array.isArray(r.scoring.podium)) return null;
    // only an untouched server envelope is replayed: the digest covers every field
    const { digest, ...body } = r.envelope;
    if (r.envelope.raceId !== raceId || digestOf(body) !== digest) return null;
    let scoring: Scoring;
    try { scoring = makeScoring(r.scoring.podium); } catch { return null; }
    // the version is derived from the points: a mismatch means the record was altered
    if (scoring.version !== r.scoring.version) return null;
    return { e: r.envelope, scoring, durable: true };
  }

  /** One pass over the queue. Concurrent calls share the pass in progress. */
  drain(): Promise<void> {
    if (!this.draining) this.draining = this.pass().finally(() => { this.draining = null; this.schedule(); });
    return this.draining;
  }

  private async pass(): Promise<void> {
    let failed = false;
    for (const q of [...this.queue.values()]) {
      if (this.stopped) return;
      const { e } = q;
      let r: 'saved' | 'failed';
      try { await this.inner.consume(e, q.scoring); r = 'saved'; } catch (err) {
        if (!(err instanceof ResultConflict)) { failed = true; this.o.log.warn('result.retry_failed', { race: e.raceId, error: String(err) }); break; }
        this.o.log.error('result.conflict', { race: e.raceId });
        r = 'failed';
      }
      this.queue.delete(e.raceId);
      if (this.o.dir) await unlink(this.file(e.raceId)).catch(() => undefined);
      this.o.log.info('result.retry_stored', { race: e.raceId, result: r });
      this.onSettled?.(e.raceId, r);
    }
    // storage is still down: try again to get every memory-only result onto disk
    if (failed && this.o.dir) {
      for (const q of [...this.queue.values()]) {
        if (this.stopped) return;
        if (!q.durable && await this.spool(q)) this.onSettled?.(q.e.raceId, 'pending');
      }
    }
    this.delay = failed ? Math.min(this.o.maxRetryMs ?? 60000, this.delay * 2) : (this.o.retryMs ?? 2000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const q of this.queue.values()) if (!q.durable) this.o.log.error('result.lost', { race: q.e.raceId, note: 'stopped before storage or the spool accepted it' });
  }
}
