import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let failed = false;
function report(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
}

report(Number(process.versions.node.split('.')[0]) >= 24, `Node.js 24 or newer (current: ${process.version})`);
for (const dependency of ['vite', 'react', 'sharp', 'quickjs-emscripten']) {
  let available = false;
  try {
    if (dependency === 'sharp') {
      const sharp = require('sharp');
      await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
    } else if (dependency === 'vite') {
      await import('vite');
    } else {
      require.resolve(dependency);
    }
    available = true;
  } catch {}
  report(available, `Installed dependency: ${dependency}`);
}
let sqlite = false;
try { const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(':memory:'); db.close(); sqlite = true; } catch {}
report(sqlite, 'Built-in SQLite is available');
report(existsSync(resolve(root, 'local/server.mjs')), 'Local server source exists');
report(existsSync(resolve(root, 'drizzle/0000_init.sql')) || existsSync(resolve(root, 'drizzle')), 'Database migrations exist');
console.log('API connections are configured in the app. This check does not open your vault or call a provider.');
process.exitCode = failed ? 1 : 0;
