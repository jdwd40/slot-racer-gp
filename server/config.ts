// Server configuration, read once from the environment (in production: the systemd EnvironmentFile, never the repo or the
// Vite bundle). Every value is validated and bounded; a bad value stops the process with a message naming the variable.
import { LIMITS } from '../src/net/protocol';
import { parsePodium } from './career';
import type { Level } from './log';

export interface Config {
  env: 'production' | 'development' | 'test';
  host: string;
  port: number;
  /** exact Origin header values allowed for WebSocket upgrades and state-changing /api requests */
  allowedOrigins: string[];
  /** most rooms open at once (each holds at most one race) */
  roomCap: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  /** seconds a disconnected participant's seat is held for reconnection */
  graceS: number;
  inputTimeoutMs: number;
  /** race state broadcasts per second */
  snapshotHz: number;
  /** most simulation steps one tick may run to catch up with wall time */
  maxCatchUpSteps: number;
  /** simulation backlog (ms of race time behind wall time) after which a race is aborted without a result */
  overloadAbortMs: number;
  /** per-connection message budget: sustained rate and burst */
  msgRate: number;
  msgBurst: number;
  /** bytes queued to one socket before it is treated as too slow and dropped (it may reconnect) */
  sendBufferMax: number;
  lobbyIdleS: number;
  resultsIdleS: number;
  roomMaxS: number;
  /** wall-clock speed-up for local tests only; always 1 in production */
  timeScale: number;
  databaseUrl: string | null;
  dbPoolMax: number;
  sessionSecret: string | null;
  cookieSecure: boolean;
  /** career points for 1st, 2nd, 3rd... (SLOTRUSH_CAREER_POINTS, default 10,6,4); the scoring version follows from them */
  careerPoints: readonly number[];
  /** where results the database could not take yet are queued durably (SLOTRUSH_SPOOL_DIR); null: memory only */
  spoolDir: string | null;
  logLevel: Level;
  version: string;
}

type Env = Record<string, string | undefined>;

function int(env: Env, k: string, def: number, lo: number, hi: number): number {
  const raw = env[k];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k} must be an integer from ${lo} to ${hi} (got ${JSON.stringify(raw)})`);
  return n;
}
function bool(env: Env, k: string, def: boolean): boolean {
  const raw = env[k];
  if (raw === undefined || raw === '') return def;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${k} must be 1/0/true/false`);
}

export function loadConfig(env: Env = process.env): Config {
  const mode = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const origins = (env.SLOTRUSH_ALLOWED_ORIGINS ?? (mode === 'production' ? '' : 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'))
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of origins) if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) throw new Error(`SLOTRUSH_ALLOWED_ORIGINS: bad origin ${o}`);
  if (mode === 'production' && !origins.length) throw new Error('SLOTRUSH_ALLOWED_ORIGINS is required in production');
  const timeScale = Number(env.SLOTRUSH_TIME_SCALE ?? '1');
  if (!Number.isFinite(timeScale) || timeScale < 1 || timeScale > 100) throw new Error('SLOTRUSH_TIME_SCALE must be 1-100');
  if (mode === 'production' && timeScale !== 1) throw new Error('SLOTRUSH_TIME_SCALE must be 1 in production');
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  const sessionSecret = env.SLOTRUSH_SESSION_SECRET?.trim() || null;
  if (databaseUrl && (!sessionSecret || sessionSecret.length < 32)) throw new Error('SLOTRUSH_SESSION_SECRET (at least 32 characters) is required with DATABASE_URL');
  if ((sessionSecret ?? '').includes('CHANGE_ME') || (databaseUrl ?? '').includes('CHANGE_ME')) throw new Error('replace the CHANGE_ME placeholders from the env example (SLOTRUSH_SESSION_SECRET, DATABASE_URL)');
  const logLevel = (env.SLOTRUSH_LOG_LEVEL ?? 'info') as Level;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error('SLOTRUSH_LOG_LEVEL must be debug, info, warn or error');
  const host = env.SLOTRUSH_HOST ?? '127.0.0.1';
  let careerPoints: readonly number[];
  try { careerPoints = parsePodium(env.SLOTRUSH_CAREER_POINTS); } catch { throw new Error('SLOTRUSH_CAREER_POINTS must be 1-8 comma-separated integers from 0 to 1000 (default 10,6,4)'); }
  const spoolDir = env.SLOTRUSH_SPOOL_DIR?.trim() || null;
  if (spoolDir && !spoolDir.startsWith('/')) throw new Error('SLOTRUSH_SPOOL_DIR must be an absolute path');
  if (mode === 'production' && databaseUrl && !spoolDir) throw new Error('SLOTRUSH_SPOOL_DIR is required in production with DATABASE_URL (results the database cannot take yet are queued there)');
  return {
    env: mode, host,
    port: int(env, 'SLOTRUSH_PORT', 8787, 0, 65535),
    allowedOrigins: origins,
    roomCap: int(env, 'SLOTRUSH_ROOM_CAP', 6, 1, 50),
    maxConnections: int(env, 'SLOTRUSH_MAX_CONNECTIONS', 48, 1, 1000),
    maxConnectionsPerIp: int(env, 'SLOTRUSH_MAX_CONNECTIONS_PER_IP', 8, 1, 100),
    graceS: int(env, 'SLOTRUSH_RECONNECT_GRACE_S', 20, 5, 120),
    inputTimeoutMs: int(env, 'SLOTRUSH_INPUT_TIMEOUT_MS', LIMITS.inputTimeoutMs, 250, 5000),
    snapshotHz: int(env, 'SLOTRUSH_SNAPSHOT_HZ', 20, 5, 60),
    maxCatchUpSteps: int(env, 'SLOTRUSH_MAX_CATCHUP_STEPS', 6, 1, 60) * Math.ceil(timeScale),
    overloadAbortMs: int(env, 'SLOTRUSH_OVERLOAD_ABORT_MS', 5000, 500, 60000),
    msgRate: int(env, 'SLOTRUSH_MSG_RATE', 40, 5, 1000),
    msgBurst: int(env, 'SLOTRUSH_MSG_BURST', 60, 5, 2000),
    sendBufferMax: int(env, 'SLOTRUSH_SEND_BUFFER_MAX', 256 * 1024, 16 * 1024, 16 * 1024 * 1024),
    lobbyIdleS: int(env, 'SLOTRUSH_LOBBY_IDLE_S', 1800, 10, 86400),
    resultsIdleS: int(env, 'SLOTRUSH_RESULTS_IDLE_S', 600, 10, 86400),
    roomMaxS: int(env, 'SLOTRUSH_ROOM_MAX_S', 3 * 3600, 60, 86400),
    timeScale,
    databaseUrl,
    dbPoolMax: int(env, 'SLOTRUSH_DB_POOL_MAX', 3, 1, 20),
    sessionSecret,
    cookieSecure: bool(env, 'SLOTRUSH_COOKIE_SECURE', mode === 'production'),
    careerPoints, spoolDir,
    logLevel,
    version: env.SLOTRUSH_VERSION ?? 'dev',
  };
}

/** Defaults for tests: no database, quick timeouts can be overridden per test. */
export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig({ NODE_ENV: 'test' }), ...over };
}
