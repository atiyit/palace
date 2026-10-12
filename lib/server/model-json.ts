import { PalaceError } from "./errors.ts";

/** 主人，我负责从模型输出中取出一个括号配对完整的 JSON 对象——只做提取，不执行文本内容，也不擅自修补语义呢。 */
export function parseModelObject(text: string, finishReason?: string | null): Record<string, unknown> {
  if (finishReason === "length" || finishReason === "max_tokens") {
    throw new PalaceError("模型输出达到长度上限，结构化内容被截断。", 502, "PROVIDER_TRUNCATED");
  }
  const input = text.trim();
  let start = -1;
  let end = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objects = 0;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (depth === 0) {
      if (character === "{") {
        objects++;
        if (objects > 1) throw new PalaceError("模型返回了多个JSON对象，无法确定本次行动。", 502, "PROVIDER_FORMAT");
        start = index; depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}") { depth--; if (depth === 0) end = index + 1; }
  }
  if (start < 0) throw new PalaceError("模型未返回JSON对象。", 502, "PROVIDER_FORMAT");
  if (end < 0 || depth !== 0 || inString) throw new PalaceError("模型返回的JSON对象或字符串未闭合。", 502, "PROVIDER_FORMAT");
  // JSON 对象外面若出现数组包裹或不配对的结构字符，我不会当作注释放过，会直接判定为格式错误哦。
  const outside = input.slice(0, start) + input.slice(end);
  if (/[\[\]{}]/.test(outside)) throw new PalaceError("JSON对象外含数组包裹或多余结构字符。", 502, "PROVIDER_FORMAT");
  try {
    const result: unknown = JSON.parse(input.slice(start, end));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("not an object");
    return result as Record<string, unknown>;
  } catch (error) {
    // JavaScript 解析器的错误信息里可能夹带原始输出片段，我替主人只留下数字位置信息，把多余的都擦干净。
    const detail = error instanceof SyntaxError ? error.message : "";
    const position = /position\s+(\d+)/i.exec(detail);
    const line = /line\s+(\d+)\s+column\s+(\d+)/i.exec(detail);
    const location = `${position ? ` JSON对象内字符位置 ${position[1]}。` : ""}${line ? ` 第${line[1]}行，第${line[2]}列。` : ""}`;
    throw new PalaceError(`JSON语法无效。${location}`, 502, "PROVIDER_FORMAT");
  }
}

export function retryableModelFormatError(error: unknown): error is PalaceError {
  return error instanceof PalaceError && (error.code === "PROVIDER_FORMAT" || error.code === "PROVIDER_TRUNCATED");
}
