// #48: a lost PostgreSQL connection must not end the room server process. The pool runs in a child process (an unhandled
// 'error' event kills the whole process, which an in-process test could not observe safely) against a minimal wire peer
// that drops its connections. No database is needed; the real-database restart test is dbrestart.db.test.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dbErrorFields } from '../../server/db';
import { bundle } from './subprocess';

const PASSWORD = 'pool-child-Secret-7fe2';

describe('PostgreSQL pool: lost connections', () => {
  let child = '';
  beforeAll(async () => { child = await bundle('test/server/pool-child.ts'); });

  it('an idle, checked-out or in-flight connection dropping is logged without credentials and the process stays alive', () => {
    const r = spawnSync(process.execPath, [child, PASSWORD], { encoding: 'utf8', timeout: 20_000 });
    const output = r.stdout + r.stderr;
    // at 7163bfc this exits 1 with "Unhandled 'error' event ... Connection terminated unexpectedly" on the first drop
    expect(r.stderr).not.toMatch(/Unhandled|uncaught/i);
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout.trim().split('\n').at(-1)!).summary;
    expect(summary).toEqual({
      listeners: 1, idleBefore: 1, totalAfterIdleDrop: 0, recoveredAfterIdle: true,
      totalAfterCheckedOutDrop: 0, recoveredAfterCheckedOut: true,
      inFlight: 'rejected: Connection terminated unexpectedly', recoveredAfterInFlight: true,
      opened: 4, ended: true,
    });
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('{"ts"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    // the idle loss is logged once, as a warning; the others reach their callers as rejected queries
    expect(lines.filter((l) => l.ev === 'db.connection_lost')).toEqual([expect.objectContaining({ lvl: 'warn', state: 'idle', error: 'Connection terminated unexpectedly' })]);
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain('pool_user:');
  });

  it('database error fields never carry the connection string or its password', () => {
    const url = 'postgres://slotrush:p%40ss-W0rd-xyz@db.internal:5432/slotrush';
    expect(dbErrorFields(Object.assign(new Error('connect to postgres://slotrush:p@ss-W0rd-xyz@db.internal failed'), { code: 'ECONNREFUSED' }), url))
      .toEqual({ code: 'ECONNREFUSED', error: 'connect to postgres://[redacted]@db.internal failed' });
    expect(dbErrorFields(new Error('auth said p@ss-W0rd-xyz'), url)).toEqual({ error: 'auth said [redacted]' });
    expect(dbErrorFields('plain', null)).toEqual({ error: 'plain' });
  });
});
