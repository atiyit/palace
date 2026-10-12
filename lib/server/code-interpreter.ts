import { getQuickJS } from 'quickjs-emscripten';

export interface OutputFile { name: string; content: string; }
export const FILE_LIMIT = 250_000;
export function validFileName(name: string): string {
  if (!name || name.length > 100 || /[\\/:\x00-\x1f<>|?*"]/u.test(name) || /^\.+$/.test(name) || !/\.(?:txt|md|csv|json|html|svg|js|css|xml|yaml|yml)$/i.test(name)) throw new Error('文件名需为100字符内的单个名称，支持 txt/md/csv/json/html/svg/js/css/xml/yaml。');
  return name;
}
export function validateOutputFile(file: OutputFile): OutputFile {
  validFileName(file.name);
  if (typeof file.content !== 'string' || new TextEncoder().encode(file.content).length > FILE_LIMIT) throw new Error('单个文件内容最多250KB。');
  return file;
}

/** 主人请放心，这个 QuickJS WASM 沙箱里不会注入 Node、process、网络或宿主文件系统对象——是个干干净净的隔离环境呢。 */
export async function runCode(code: string, inputFiles: Record<string, string> = {}, timeoutMs = 2000) {
  if (!code.trim() || code.length > 30_000) throw new Error('代码需为1至30000字符的JavaScript。');
  const quick = await getQuickJS();
  const runtime = quick.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  const output: string[] = [], files: OutputFile[] = [];
  let outputChars = 0;
  const log = vm.newFunction('log', (...args) => {
    const line = args.map(arg => { const value = vm.dump(arg); return typeof value === 'string' ? value : JSON.stringify(value); }).join(' ').slice(0, 4000);
    outputChars += line.length;
    if (outputChars > 12_000) throw new Error('输出日志超过12000字符。');
    output.push(line);
  });
  const emit = vm.newFunction('emitFile', (name, content) => {
    if (files.length >= 5) throw new Error('每次运行最多生成5个文件。');
    const file = validateOutputFile({ name: vm.getString(name), content: vm.getString(content) });
    if (files.some(existing => existing.name === file.name)) throw new Error('同一次运行的文件名不能重复。');
    files.push(file);
  });
  try {
    const consoleObject = vm.newObject();
    vm.setProp(consoleObject, 'log', log); vm.setProp(vm.global, 'console', consoleObject); consoleObject.dispose();
    vm.setProp(vm.global, 'emitFile', emit);
    const inputs = vm.unwrapResult(vm.evalCode(`globalThis.files=Object.freeze(${JSON.stringify(inputFiles)});`)); inputs.dispose();
    const result = vm.evalCode(code, 'task.js');
    if (result.error) { const error = vm.dump(result.error); result.error.dispose(); throw new Error(String(error?.message || '代码执行失败').slice(0, 500)); }
    result.value.dispose();
    return { output: output.join('\n') || '代码执行完成。', files };
  } finally { log.dispose(); emit.dispose(); vm.dispose(); runtime.dispose(); }
}
