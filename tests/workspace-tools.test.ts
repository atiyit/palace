import test from 'node:test';
import assert from 'node:assert/strict';
import { FILE_LIMIT, runCode, validateOutputFile, validFileName } from '../lib/server/code-interpreter.ts';
import { parseSearchResults, plainText, publicAddress, publicUrl } from '../lib/server/web-tools.ts';

test('isolated code interpreter computes values and exports CSV with provided file inputs', async () => {
  const result = await runCode(`
    const rows = files['input.csv'].trim().split('\\n').slice(1).map(Number);
    console.log('sum', rows.reduce((sum, value) => sum + value, 0));
    emitFile('result.csv', 'value\\n' + rows.map(value => value * 2).join('\\n'));
  `, { 'input.csv': 'value\n2\n4\n6' });
  assert.equal(result.output, 'sum 12');
  assert.deepEqual(result.files, [{ name: 'result.csv', content: 'value\n4\n8\n12' }]);
});

test('WASM sandbox exposes no Node, network, browser, filesystem or host module handles', async () => {
  const result = await runCode(`
    console.log(JSON.stringify(['process','require','fetch','Buffer','window','document','Deno','Bun','fs','XMLHttpRequest','WebSocket'].map(name => [name, typeof globalThis[name]])));
    console.log(Function('return typeof process')());
  `);
  const [globals, constructorProbe] = result.output.split('\n');
  assert.ok((JSON.parse(globals) as [string, string][]).every(([, type]) => type === 'undefined'));
  assert.equal(constructorProbe, 'undefined');
  assert.deepEqual(result.files, []);
});

test('input file snapshot is frozen and does not mutate the host input object', async () => {
  const input = { 'facts.txt': 'original' };
  const result = await runCode(`files['facts.txt'] = 'modified'; console.log(files['facts.txt']); console.log(Object.isFrozen(files));`, input);
  assert.equal(result.output, 'original\ntrue');
  assert.deepEqual(input, { 'facts.txt': 'original' });
});

test('unbounded guest loops are interrupted promptly and cannot return partial files', async () => {
  const start = Date.now();
  await assert.rejects(() => runCode(`emitFile('partial.txt', 'must not be returned'); while (true) {}`, {}, 60), /interrupt|中断|执行失败/i);
  assert.ok(Date.now() - start < 3000, 'interrupt handler should bound guest execution');
  const after = await runCode('console.log(2 + 3)');
  assert.equal(after.output, '5');
});

test('guest allocations are restricted by the configured memory cap', async () => {
  const start = Date.now();
  await assert.rejects(() => runCode(`const blocks=[]; while(true) blocks.push(new Array(1_000_000).fill('memory'));`, {}, 1500), /memory|内存|alloc|执行失败|interrupt/i);
  assert.ok(Date.now() - start < 3500, 'memory abuse must be bounded');
  assert.equal((await runCode('console.log("still healthy")')).output, 'still healthy');
});

test('unsafe filenames and oversized UTF-8 files fail validation', () => {
  for (const name of ['', '../escape.txt', 'C:\\escape.txt', 'a/b.csv', '.', 'archive.zip', 'a\u0000.txt', `${'x'.repeat(101)}.txt`]) assert.throws(() => validFileName(name));
  for (const name of ['report.csv', '结果.md', 'summary.json', 'index.html', 'drawing.svg']) assert.equal(validFileName(name), name);
  assert.equal(validateOutputFile({ name: 'limit.txt', content: 'x'.repeat(FILE_LIMIT) }).content.length, FILE_LIMIT);
  assert.throws(() => validateOutputFile({ name: 'too-large.txt', content: 'x'.repeat(FILE_LIMIT + 1) }), /250KB/);
  assert.throws(() => validateOutputFile({ name: 'utf8.txt', content: '字'.repeat(90_000) }), /250KB/);
});

test('export misuse, duplicate outputs and runtime exceptions reject the entire result', async () => {
  for (const code of [
    `emitFile('first.txt', 'valid'); emitFile('../escape.txt', 'invalid');`,
    `emitFile('big.txt', 'x'.repeat(${FILE_LIMIT + 1}));`,
    `emitFile('same.txt', 'one'); emitFile('same.txt', 'two');`,
    `for(let i=0;i<6;i++) emitFile('file'+i+'.txt', 'data');`,
    `emitFile('partial.txt', 'partial'); throw new Error('intentional failure');`,
    `for(let i=0;i<4;i++) console.log('x'.repeat(4000));`,
  ]) await assert.rejects(() => runCode(code));
});

test('network address classifier rejects loopback, private, multicast and reserved addresses', () => {
  for (const address of ['localhost', '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
});

test('reserved IPv6 spellings cannot bypass network filtering via leading zeroes', () => {
  for (const address of ['2001:0db8::1', '2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:0000::1', '2001:0010::1', '2001:0020::1']) assert.equal(publicAddress(address), false, address);
});

test('URL checks reject internal hosts, credentials, nonstandard ports and alternate protocols before connecting', async () => {
  for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://192.168.0.1/', 'https://user:password@example.com/', 'https://example.com:8443/', 'file:///C:/secret.txt', 'ftp://example.com/a']) await assert.rejects(() => publicUrl(url), url);
});

test('RSS search results preserve links and decode readable snippets', () => {
  const results = parseSearchResults('<rss><channel><item><title><![CDATA[Example &amp; reference]]></title><link>https://example.com/?a=1&amp;b=2</link><description><![CDATA[<b>Useful</b> &lt;source&gt;]]></description></item><item><title>Unsafe</title><link>javascript:alert(1)</link><description>ignore</description></item></channel></rss>');
  assert.deepEqual(results, [{ title: 'Example & reference', url: 'https://example.com/?a=1&b=2', snippet: 'Useful' }]);
});

test('DDG search links unwrap redirect destinations and strip markup from titles', () => {
  const results = parseSearchResults('<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=test"><b>Example</b> docs</a>');
  assert.deepEqual(results, [{ title: 'Example docs', url: 'https://example.com/docs', snippet: '' }]);
  assert.equal(plainText('<script>secret()</script><style>hidden{}</style><p>A &amp; B</p>'), 'A & B');
});
