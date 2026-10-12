import { bootstrapLocalDefaults } from './storage.ts';

async function hiddenInput() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 12000) throw new Error('初始化输入超过长度限制。');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('Ready for hidden bootstrap JSON (press Enter to submit).\n');
  return new Promise((resolve, reject) => {
    let input = '';
    const finish = (error) => {
      process.stdin.off('data', receive);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (error) reject(error); else resolve(input.trim());
    };
    const receive = chunk => {
      const text = chunk.toString('utf8');
      if (text.includes('\u0003')) return finish(new Error('初始化已取消。'));
      const end = text.search(/[\r\n]/);
      input += end === -1 ? text : text.slice(0, end);
      if (Buffer.byteLength(input) > 12000) return finish(new Error('初始化输入超过长度限制。'));
      if (end !== -1) finish();
    };
    process.stdin.on('data', receive);
  });
}

try {
  const input = JSON.parse(await hiddenInput());
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('初始化输入必须是 JSON 对象。');
  await bootstrapLocalDefaults(input);
  process.stdout.write('本地默认 API 配置已加密保存。\n');
} catch (error) {
  // 主人，不打印输入内容、错误原因链或可能含有敏感信息的 JSON 片段。
  const message = error instanceof SyntaxError ? '初始化 JSON 无效。' : error instanceof Error ? error.message : '本地初始化失败。';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
