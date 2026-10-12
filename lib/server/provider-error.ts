import { PalaceError } from "./errors.ts";

const quotaCodes = new Set(["pre_consume_token_quota_failed", "insufficient_quota"]);
const quotaMessage = /token\s+quota\s+is\s+not\s+enough|insufficient\s+(?:account\s+)?(?:balance|quota)|(?:account\s+)?balance\s+(?:is\s+)?not\s+enough|余额不足|可用(?:余额|额度)不足/i;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** 主人，识别已知的服务商错误类型，但不会暴露网关原始响应或余额信息。 */
export function classifyProviderError(status: number, responseText: string): PalaceError {
  let code = "";
  let message = responseText.slice(0, 100_000);
  try {
    const payload = record(JSON.parse(message));
    const error = record(payload?.error) || payload;
    code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
    message = typeof error?.message === "string" ? error.message : typeof payload?.error === "string" ? payload.error : "";
  } catch { /* A plain-text gateway error can still contain an explicit balance message. */ }
  if (quotaCodes.has(code) || quotaMessage.test(message)) return new PalaceError("模型服务余额不足，请充值或在庭院设置更换 API Key。", 502, "PROVIDER_QUOTA");
  if (status === 429) return new PalaceError("模型服务请求过于频繁，请稍后重试。", 502, "PROVIDER_ERROR");
  if (status === 401 || status === 403) return new PalaceError("模型服务拒绝访问，请检查服务端密钥与模型权限。", 502, "PROVIDER_ERROR");
  return new PalaceError(`模型服务暂时出错（HTTP ${status}），本次操作未完成。`, 502, "PROVIDER_ERROR");
}
