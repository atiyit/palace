import { AsyncLocalStorage } from "node:async_hooks";
import type { DebugTrace } from "../debug-types.ts";

interface TraceContext { preview: boolean; entries: DebugTrace[]; secrets: string[]; }
const context = new AsyncLocalStorage<TraceContext>();
export class PreviewHalt extends Error { constructor() { super("预览已生成，未调用模型。"); } }
const MAX_TRACE_CHARS = 100_000;
export const isProviderPreview = () => context.getStore()?.preview === true;
export function redactDebugValue<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") {
    let result: string = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result as T;
  }
  if (Array.isArray(value)) return value.map(item => redactDebugValue(item, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactDebugValue(key, secrets), redactDebugValue(item, secrets)])) as T;
  return value;
}
function clean(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result.length > MAX_TRACE_CHARS ? `${result.slice(0, MAX_TRACE_CHARS)}\n[内容已截断]` : result;
}
export async function withProviderTrace<T>(preview: boolean, operation: () => Promise<T>): Promise<{ value?: T; error?: unknown; trace: DebugTrace[] }> {
  const scope: TraceContext = { preview, entries: [], secrets: [] };
  return context.run(scope, async () => {
    try { return { value: await operation(), trace: scope.entries }; }
    catch (error) { return { error, trace: scope.entries }; }
  });
}
export function beginProviderTrace(input: Omit<DebugTrace, "id" | "status">, secret = ""): DebugTrace | undefined {
  const scope = context.getStore();
  if (!scope) return undefined;
  if (secret && !scope.secrets.includes(secret)) scope.secrets.push(secret);
  const entry: DebugTrace = { id: crypto.randomUUID(), kind: input.kind, model: input.model, endpoint: input.endpoint, status: scope.preview ? "preview" : "pending" };
  if (input.messages) entry.messages = input.messages.map(message => ({ role: message.role, content: clean(message.content, scope.secrets) }));
  if (input.prompt !== undefined) entry.prompt = clean(input.prompt, scope.secrets);
  if (input.reference) entry.reference = { ...input.reference, sourceUrl: clean(input.reference.sourceUrl, scope.secrets) };
  if (input.protocol) entry.protocol = input.protocol;
  if (input.inputImages) entry.inputImages = redactDebugValue(input.inputImages, scope.secrets);
  scope.entries.push(entry);
  if (scope.preview) throw new PreviewHalt();
  return entry;
}
export function updateProviderTrace(entry: DebugTrace | undefined, update: Partial<DebugTrace>): void {
  const scope = context.getStore();
  if (!entry || !scope) return;
  if (update.raw !== undefined) entry.raw = clean(update.raw, scope.secrets);
  if (update.parsed !== undefined) {
    const encoded = clean(JSON.stringify(update.parsed), scope.secrets);
    try { entry.parsed = JSON.parse(encoded); } catch { entry.parsed = { truncated: true, text: encoded }; }
  }
  if (update.error !== undefined) entry.error = clean(update.error, scope.secrets);
  if (update.status !== undefined) entry.status = update.status;
  if (update.tokens !== undefined) entry.tokens = update.tokens;
  if (update.finishReason !== undefined) entry.finishReason = update.finishReason;
  if (update.elapsedMs !== undefined) entry.elapsedMs = update.elapsedMs;
}
export function markLastTraceValidation(stage: string, reason: string): void {
  const scope = context.getStore();
  const entry = scope?.entries[scope.entries.length - 1];
  updateProviderTrace(entry, { status: "error", error: `${stage}：${reason}` });
}
