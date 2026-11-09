// Durable delivery of finalized results to storage. A result the database cannot take right now (down, timing out) is written
// to a spool file on local disk (fsynced, then renamed into place) before the room is told 'pending', and retried until the
// database accepts it, including after a restart (the spool is drained at start). Storage is idempotent by raceId
// (server/results.ts), so a retry after a commit whose reply was lost, a second process, or a re-delivered file can never
// award twice. Without a spool directory the queue lives in memory only (development, tests) and a restart loses it; that
// is logged. docs/career.md.
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digestOf, type ResultEnvelope } from './envelope';
import type { Logger } from './log';
import { ResultConflict, type ConsumeResult, type ResultSink } from './results';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DurableOpts {
  /** spool directory (production: /var/lib/slotrush-server/spool via systemd StateDirectory); null keeps the queue in memory */
  dir: string | null;
  log: Logger;
  /** first retry delay; doubles up to maxRetryMs */
  retryMs?: number;
  maxRetryMs?: number;
}

export class DurableSink implements ResultSink {
  /** results waiting for storage, by raceId */
  private queue = new Map<string, Readonly<ResultEnvelope>>();
  private timer: NodeJS.Timeout | null = null;
  private delay: number;
  private draining: Promise<void> | null = null;
  private stopped = false;
  /** told when a queued result has been stored (or found already stored): rooms update their 'pending' notice */
  onSettled: ((raceId: string, r: 'saved' | 'failed') => void) | null = null;

  constructor(private inner: ResultSink, private o: DurableOpts) { this.delay = o.retryMs ?? 2000; }

  get pending(): number { return this.queue.size; }

  async consume(e: Readonly<ResultEnvelope>): Promise<ConsumeResult> {
    if (this.queue.has(e.raceId)) return 'queued';
    try {
      return await this.inner.consume(e);
    } catch (err) {
      if (err instanceof ResultConflict) throw err;
      this.o.log.error('result.store_failed', { race: e.raceId, error: String(err) });
      await this.enqueue(e);
      return 'queued';
    }
  }

  private file(raceId: string): string { return join(this.o.dir!, `${raceId}.json`); }

  private async enqueue(e: Readonly<ResultEnvelope>): Promise<void> {
    this.queue.set(e.raceId, e);
    if (this.o.dir) {
      try {
        await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.file(e.raceId)}.tmp`;
        const fh = await open(tmp, 'w', 0o600);
        try { await fh.writeFile(JSON.stringify(e)); await fh.sync(); } finally { await fh.close(); }
        await rename(tmp, this.file(e.raceId));
        this.o.log.warn('result.spooled', { race: e.raceId });
      } catch (err) {
        this.o.log.error('result.spool_failed', { race: e.raceId, error: String(err), note: 'held in memory only' });
      }
    } else {
      this.o.log.warn('result.queued_memory', { race: e.raceId, note: 'no SLOTRUSH_SPOOL_DIR: lost if the process stops' });
    }
    this.schedule();
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
          const e = JSON.parse(await readFile(join(this.o.dir, n), 'utf8')) as ResultEnvelope;
          // only an untouched server envelope is replayed: the digest covers every field
          const { digest, ...body } = e;
          if (e.raceId !== n.slice(0, -5) || digestOf(body) !== digest) { this.o.log.error('result.spool_corrupt', { file: n }); await rename(join(this.o.dir, n), join(this.o.dir, `${n}.bad`)); continue; }
          this.queue.set(e.raceId, e);
        } catch (err) { this.o.log.error('result.spool_unreadable', { file: n, error: String(err) }); }
      }
      if (this.queue.size) this.o.log.info('result.spool_loaded', { pending: this.queue.size });
    }
    await this.drain();
  }

  /** One pass over the queue. Concurrent calls share the pass in progress. */
  drain(): Promise<void> {
    if (!this.draining) this.draining = this.pass().finally(() => { this.draining = null; this.schedule(); });
    return this.draining;
  }

  private async pass(): Promise<void> {
    let failed = false;
    for (const e of [...this.queue.values()]) {
      if (this.stopped) return;
      let r: 'saved' | 'failed';
      try { await this.inner.consume(e); r = 'saved'; } catch (err) {
        if (!(err instanceof ResultConflict)) { failed = true; this.o.log.warn('result.retry_failed', { race: e.raceId, error: String(err) }); break; }
        this.o.log.error('result.conflict', { race: e.raceId });
        r = 'failed';
      }
      this.queue.delete(e.raceId);
      if (this.o.dir) await unlink(this.file(e.raceId)).catch(() => undefined);
      this.o.log.info('result.retry_stored', { race: e.raceId, result: r });
      this.onSettled?.(e.raceId, r);
    }
    this.delay = failed ? Math.min(this.o.maxRetryMs ?? 60000, this.delay * 2) : (this.o.retryMs ?? 2000);
  }

  stop(): void { this.stopped = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
