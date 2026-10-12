import { fileURLToPath } from 'node:url';
import { stop } from './local-launcher.mjs';
if (process.argv[2] !== 'stop') throw new Error('Usage: node scripts/local-control.mjs stop');
await stop(fileURLToPath(new URL('../', import.meta.url)));
