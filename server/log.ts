// Structured JSON-line logging to stdout/stderr (journald under systemd). Secrets never reach a log line: reconnect tokens,
// passwords, cookies and session IDs are not passed to the logger, and `redact` strips any field with a secret-looking name
// as a second line of defence.
export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /token|password|secret|cookie|sid|authorization|hash/i;

export interface Logger {
  debug(ev: string, f?: Record<string, unknown>): void;
  info(ev: string, f?: Record<string, unknown>): void;
  warn(ev: string, f?: Record<string, unknown>): void;
  error(ev: string, f?: Record<string, unknown>): void;
}

export function redact(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) out[k] = SECRET.test(k) ? '[redacted]' : v;
  return out;
}

export function createLogger(level: Level = 'info', sink: (line: string, lvl: Level) => void = defaultSink): Logger {
  const emit = (lvl: Level, ev: string, f: Record<string, unknown> = {}): void => {
    if (RANK[lvl] < RANK[level]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), lvl, ev, ...redact(f) }), lvl);
  };
  return {
    debug: (ev, f) => emit('debug', ev, f), info: (ev, f) => emit('info', ev, f),
    warn: (ev, f) => emit('warn', ev, f), error: (ev, f) => emit('error', ev, f),
  };
}
function defaultSink(line: string, lvl: Level): void { (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n'); }

/** A logger that keeps lines in memory (tests check that no secret is ever logged). */
export function memoryLogger(level: Level = 'debug'): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(createLogger(level, (l) => { lines.push(l); }), { lines });
}
