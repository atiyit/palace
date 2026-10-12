import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1);
const executable = realpathSync(process.execPath);
const directory = dirname(executable);
// 我会按相对于当前 node 可执行文件的已知目录布局来寻找 npm-cli.js，替主人避开系统上可能混入的其他版本 npm 呢。
const candidates = [
  join(directory, 'node_modules/npm/bin/npm-cli.js'),
  join(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
  process.env.npm_execpath,
];
const npm = candidates.find(value => value && existsSync(value) && value.endsWith('npm-cli.js'));
if (!npm) process.exit(1);
console.log(JSON.stringify({ node: executable, npm: realpathSync(npm), version: process.version }).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
