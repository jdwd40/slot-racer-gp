// Process-level fault handling (#166): an uncaught exception or unhandled rejection is logged, then the server takes its
// normal graceful stop path (races end without a result, results still being written are awaited and spooled) and exits
// non-zero so systemd restarts it. Only a backstop: per-room ticks (rooms.ts) and per-socket messages (app.ts) already
// isolate their own faults.
import type { Logger } from './log';

export interface FaultHooks {
  log: Logger;
  /** the graceful stop; it must end the process with `code` (main.ts keeps its 5 s hard exit) */
  stop: (reason: string, code: number) => void;
  /** immediate exit, used only when the stop itself throws */
  exit: (code: number) => void;
  /** where the handlers are registered (process.on in production) */
  on?: (ev: 'uncaughtException' | 'unhandledRejection', fn: (e: unknown) => void) => void;
}

export const FAULT_EXIT = 1;

/** Install the handlers; returns the handler so tests can drive it without a real fault. */
export function installFaultHandlers(h: FaultHooks): (kind: 'uncaughtException' | 'unhandledRejection', e: unknown) => void {
  let faulted = false;
  const onFault = (kind: 'uncaughtException' | 'unhandledRejection', e: unknown): void => {
    try {
      h.log.error('process.fault', { kind, error: String(e), stack: e instanceof Error ? e.stack : undefined, again: faulted });
    } catch { /* a broken logger must not stop the shutdown */ }
    // a second fault (often from the stop itself) never starts another stop: the first is already ending the process,
    // bounded by its hard exit
    if (faulted) return;
    faulted = true;
    try {
      h.stop(kind, FAULT_EXIT);
    } catch (e2) {
      try { h.log.error('process.fault_stop_failed', { error: String(e2) }); } catch { /* ignore */ }
      h.exit(FAULT_EXIT);
    }
  };
  const on = h.on ?? ((ev, fn) => { process.on(ev, fn); });
  on('uncaughtException', (e) => onFault('uncaughtException', e));
  on('unhandledRejection', (e) => onFault('unhandledRejection', e));
  return onFault;
}
