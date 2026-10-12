/** 主人，这里只存放公开的连接示例，凭证信息不会出现在这份目录中。 */
export type ProviderProtocol = "openai-chat" | "openai-responses" | "anthropic" | "ollama";
export type PresetProviderKind = "text" | "image";
export interface ProviderConnectionDraft {
  baseUrl: string;
  model: string;
  apiKey: string;
  protocol: ProviderProtocol;
  local: boolean;
  referenceModel?: string;
  visionEnabled?: boolean;
}
export interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  connection?: Omit<ProviderConnectionDraft, "apiKey">;
}

export const PROVIDER_PROTOCOLS: ReadonlyArray<{ value: ProviderProtocol; label: string; description: string }> = [
  { value: "openai-chat", label: "OpenAI Chat Completions", description: "使用 chat/completions；适用于 DeepSeek、xAI、LM Studio 和其他兼容服务。" },
  { value: "openai-responses", label: "OpenAI Responses", description: "使用 responses；服务需要提供 Responses 接口。" },
  { value: "anthropic", label: "Anthropic Messages", description: "使用 Anthropic 原生 messages 接口。" },
  { value: "ollama", label: "Ollama 原生", description: "使用 /api/chat；基础地址不需要填写 /v1。" },
];

export const PROVIDER_PRESETS: Readonly<Record<PresetProviderKind, readonly ProviderPreset[]>> = {
  text: [
    { id: "openai", label: "OpenAI", description: "OpenAI 官方服务，预填稳定模型示例；可以改为账号可用的其他模型。", connection: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", protocol: "openai-responses", local: false } },
    { id: "anthropic", label: "Anthropic", description: "Anthropic 官方原生 Messages 接口。", connection: { baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-4-6", protocol: "anthropic", local: false } },
    { id: "xai", label: "Grok · xAI", description: "xAI 官方 Responses 接口。", connection: { baseUrl: "https://api.x.ai/v1", model: "grok-4.7", protocol: "openai-responses", local: false } },
    { id: "deepseek", label: "DeepSeek", description: "DeepSeek 官方兼容接口。", connection: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", protocol: "openai-chat", local: false } },
    { id: "ollama", label: "Ollama · 本机", description: "先启动本机 Ollama，并填写已下载的模型名称。", connection: { baseUrl: "http://127.0.0.1:11434", model: "", protocol: "ollama", local: true } },
    { id: "lm-studio", label: "LM Studio · 本机", description: "先在 LM Studio 启动服务，再填写已加载模型的标识。", connection: { baseUrl: "http://127.0.0.1:1234/v1", model: "", protocol: "openai-chat", local: true } },
    { id: "custom", label: "自定义", description: "手动填写服务地址、模型与协议；保留当前字段供你修改。" },
  ],
  image: [
    { id: "openai", label: "OpenAI", description: "使用 images/generations 与 images/edits。", connection: { baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", referenceModel: "gpt-image-1", protocol: "openai-chat", local: false } },
    { id: "local-image", label: "自定义本地 · OpenAI 兼容", description: "填写本机图片服务的端口与模型；服务须支持 images/generations，参考图还需 images/edits。", connection: { baseUrl: "http://127.0.0.1:8000/v1", model: "", referenceModel: "", protocol: "openai-chat", local: true } },
    { id: "custom", label: "自定义", description: "手动填写远端或本机图片服务地址，两个图片模型共享此连接。" },
  ],
};

/** 主人，选择任何预设时会丢弃未保存的凭证，而不是把它转发给其他服务。 */
export function applyProviderPreset<T extends ProviderConnectionDraft>(draft: T, preset: ProviderPreset): T {
  return { ...draft, ...preset.connection, apiKey: "", ...(preset.connection && "visionEnabled" in draft ? { visionEnabled: false } : {}) };
}

export function providerOrigin(value: string, local = false): string | null {
  try {
    const input = value.trim();
    return new URL(input.includes("://") ? input : `${local ? "http" : "https"}://${input}`).origin;
  } catch { return null; }
}

/** 主人，这里只做客户端可见的本地地址约束镜像；服务端的校验仍然是权威的。 */
export function isLocalProviderAddress(value: string): boolean {
  try {
    const input = value.trim();
    const url = new URL(input.includes("://") ? input : `http://${input}`);
    const authority = input.replace(/^[a-z]+:\/\//i, "").split("/")[0];
    const explicitPort = /:(\d+)$/.exec(authority)?.[1];
    return ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
      && !!explicitPort && Number(explicitPort) >= 1 && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function detectProviderPreset(kind: PresetProviderKind, provider: { baseUrl: string; protocol?: ProviderProtocol; local?: boolean }): string {
  const normalized = provider.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  return PROVIDER_PRESETS[kind].find(preset => preset.connection
    && preset.connection.baseUrl.toLowerCase() === normalized
    && preset.connection.protocol === (provider.protocol || "openai-chat")
    && preset.connection.local === !!provider.local)?.id || "custom";
}
