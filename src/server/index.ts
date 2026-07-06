// index.ts — process entrypoint: boot the backend from the environment and
// handle signals. All assembly lives in boot.ts so tests boot the same stack.

import { boot } from './boot.js';
import { INSTRUMENTS, loadConfig } from './config.js';

const backend = await boot(loadConfig());

if (backend.reconciledOrders > 0) {
  console.log(`boot: canceled ${backend.reconciledOrders} orphaned open orders from previous run`);
}
console.log(`exchange listening on :${backend.port} (${INSTRUMENTS.map((i) => i.symbol).join(', ')})`);

async function shutdown(): Promise<void> {
  console.log('shutting down: flushing write-behind…');
  await backend.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
