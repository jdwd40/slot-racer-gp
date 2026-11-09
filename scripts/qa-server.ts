// Test tooling only (never in server-dist or a release): the real room server (createApp + RoomManager, the same modules
// main.ts runs) started in the check's own process, so scripts/online-check.mjs can read and seed authoritative race state
// (for example award a stop-and-go) while real browsers play through /ws. Bundled on the fly by online-check.mjs.
import { createApp } from '../server/app';
import { testConfig, type Config } from '../server/config';
import { memoryLogger } from '../server/log';
import { MemoryResultSink } from '../server/results';
import { RoomManager } from '../server/rooms';

export async function startQaServer(over: Partial<Config>) {
  const cfg = testConfig({ host: '127.0.0.1', port: 0, ...over });
  const log = memoryLogger('info');
  const sink = new MemoryResultSink();
  const manager = new RoomManager({ cfg, log, sink });
  const app = createApp({ cfg, log, manager });
  const { port } = await app.listen();
  manager.start();
  return {
    cfg, log, sink, manager, port, url: `http://127.0.0.1:${port}`,
    room: (code: string) => manager.byCode(code),
    async close() { manager.shutdown('shutdown'); await app.close(); },
  };
}
