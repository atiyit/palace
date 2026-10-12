import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1);
const executable = realpathSync(process.execPath);
const directory = dirname(executable);
// 主人，这里按相对于当前 node 可执行文件的已知布局寻找 npm-cli.js，避免意外调用到系统上其他版本的 npm。
const candidates = [
  join(directory, 'node_modules/npm/bin/npm-cli.js'),
  join(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
  process.env.npm_execpath,
];
const npm = candidates.find(value => value && existsSync(value) && value.endsWith('npm-cli.js'));
if (!npm) process.exit(1);
console.log(JSON.stringify({ node: executable, npm: realpathSync(npm), version: process.version }).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
