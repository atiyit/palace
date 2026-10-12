"use client";

import { AUTH_ERROR, IS_LOCAL_APP } from "@/components/runtime-mode";
import { DEFAULT_CUSTOM_IMAGE_PROMPT, IMAGE_PROMPT_STYLES, IMAGE_PROMPT_VARIABLES, MAX_CUSTOM_IMAGE_PROMPT_CHARS, renderImagePrompt, type ImagePromptStyle } from "@/lib/image-prompts";
import { PROVIDER_PRESETS, PROVIDER_PROTOCOLS, applyProviderPreset, detectProviderPreset, isLocalProviderAddress, providerOrigin, type ProviderProtocol } from "@/lib/provider-presets";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleHelp, ImagePlus, KeyRound, LoaderCircle, LockKeyhole, MessageCircle, RefreshCw, RotateCcw } from "lucide-react";

type ProviderKind = "text" | "image";
type Provider = {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keyHint: string;
  source: "default" | "custom";
  protocol?: ProviderProtocol;
  local?: boolean;
  visionEnabled?: boolean;
  referenceModel?: string;
  promptStyle?: ImagePromptStyle;
  customPrompt?: string;
};
type Providers = Record<ProviderKind, Provider>;
type Draft = { baseUrl: string; model: string; apiKey: string; referenceModel: string; promptStyle: ImagePromptStyle; customPrompt: string; protocol: ProviderProtocol; local: boolean; visionEnabled: boolean };
type Notice = { text: string; error?: boolean };
type ProviderResult = { settings?: Providers; message?: string; error?: string; code?: string };

const EMPTY: Draft = { baseUrl: "", model: "", apiKey: "", referenceModel: "nai-diffusion-4-5-full", promptStyle: "default", customPrompt: "", protocol: "openai-chat", local: false, visionEnabled: false };
const KINDS: ProviderKind[] = ["text", "image"];
const LABELS = { text: "文本模型", image: "生图模型" };
const toDraft = (provider: Provider): Draft => ({ baseUrl: provider.baseUrl, model: provider.model, apiKey: "", referenceModel: provider.referenceModel || "nai-diffusion-4-5-full", promptStyle: provider.promptStyle || "default", customPrompt: provider.customPrompt || "", protocol: provider.protocol || "openai-chat", local: !!provider.local, visionEnabled: !!provider.visionEnabled });
function redact(message: string, secret = "") {
  const clean = secret ? message.split(secret).join("[已隐藏 Key]") : message;
  return clean.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[已隐藏 Key]");
}
const changedOrigin = (draft: Draft, provider: Pick<Provider, "baseUrl" | "local">) => providerOrigin(draft.baseUrl, draft.local) !== providerOrigin(provider.baseUrl, provider.local);

export function ProviderSettings({ busy, onSaved, onBusyChange }: {
  busy: boolean;
  onSaved: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<Providers | null>(null);
  const [drafts, setDrafts] = useState<Record<ProviderKind, Draft>>({ text: { ...EMPTY }, image: { ...EMPTY } });
  const [presets, setPresets] = useState<Record<ProviderKind, string>>({ text: "custom", image: "custom" });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [saving, setSaving] = useState<{ kind: ProviderKind; action: "save" | "reset" } | null>(null);
  const [notices, setNotices] = useState<Partial<Record<ProviderKind, Notice>>>({});
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(""); setAuthRequired(false);
    try {
      const response = await fetch("/api/provider-settings", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const result = await response.json() as Providers & { error?: string };
      if (!response.ok) throw new Error(result.error || "暂时无法读取模型配置，请重试。");
      if (!result.text || !result.image) throw new Error("配置返回不完整，请重新读取。");
      setSettings(result);
      setDrafts({ text: toDraft(result.text), image: toDraft(result.image) });
      setPresets({ text: detectProviderPreset("text", result.text), image: detectProviderPreset("image", result.image) });
    } catch (error) {
      setLoadError(redact(error instanceof Error ? error.message : "读取配置失败，请重试。"));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const edit = <K extends keyof Draft>(kind: ProviderKind, field: K, value: Draft[K]) => {
    setDrafts(current => {
      const draft = { ...current[kind], [field]: value };
      if (field === "local" || (field === "baseUrl" && changedOrigin(draft, current[kind]))) draft.apiKey = "";
      return { ...current, [kind]: draft };
    });
    if (["baseUrl", "model", "referenceModel", "protocol", "local"].includes(field)) setPresets(current => ({ ...current, [kind]: "custom" }));
    setNotices(current => ({ ...current, [kind]: undefined }));
  };
  const choosePreset = (kind: ProviderKind, presetId: string) => {
    const preset = PROVIDER_PRESETS[kind].find(item => item.id === presetId);
    if (!preset) return;
    setDrafts(current => ({ ...current, [kind]: applyProviderPreset(current[kind], preset) }));
    setPresets(current => ({ ...current, [kind]: presetId }));
    setNotices(current => ({ ...current, [kind]: undefined }));
  };
  const mutate = async (kind: ProviderKind, action: "save" | "reset") => {
    if (busy || savingRef.current || !settings) return;
    const draft = drafts[kind];
    if (action === "save") {
      if (!draft.baseUrl.trim() || !draft.model.trim()) {
        setNotices(current => ({ ...current, [kind]: { error: true, text: "请填写 API 地址与模型名称。" } })); return;
      }
      if (kind === "image" && !draft.referenceModel.trim()) {
        setNotices(current => ({ ...current, image: { error: true, text: "请填写参考图模型名称。文生图与参考图可以使用不同模型。" } })); return;
      }
      if (draft.local && !isLocalProviderAddress(draft.baseUrl)) {
        setNotices(current => ({ ...current, [kind]: { error: true, text: "本机服务请填写 localhost、127.0.0.1 或 [::1]，并明确指定端口，例如 http://127.0.0.1:1234/v1。" } })); return;
      }
      if (!draft.local && (changedOrigin(draft, settings[kind]) || settings[kind].local) && !draft.apiKey.trim()) {
        setNotices(current => ({ ...current, [kind]: { error: true, text: "你更换了 API 地址的来源，请为新地址输入对应的 Key。" } })); return;
      }
    }
    savingRef.current = true;
    setSaving({ kind, action }); onBusyChange(true);
    setNotices(current => ({ ...current, [kind]: undefined }));
    try {
      const response = await fetch("/api/provider-settings", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "reset" ? { action, kind } : {
          action, kind, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: draft.apiKey.trim(),
          protocol: draft.protocol, local: draft.local,
          ...(kind === "text" ? { visionEnabled: draft.visionEnabled } : {}),
          ...(kind === "image" ? { referenceModel: draft.referenceModel.trim(), promptStyle: draft.promptStyle, customPrompt: draft.customPrompt } : {}),
        }),
      });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const result = await response.json() as ProviderResult;
      if (!response.ok || result.error) throw new Error(result.error || "配置尚未保存，请重试。");
      if (!result.settings) throw new Error("未收到保存后的配置，请重新读取确认。");
      setSettings(result.settings);
      // 主人，立即清除已提交的密钥内容；保留另一个渠道尚未保存的草稿。
      setDrafts(current => ({ ...current, [kind]: toDraft(result.settings![kind]) }));
      setPresets(current => ({ ...current, [kind]: detectProviderPreset(kind, result.settings![kind]) }));
      setNotices(current => ({ ...current, [kind]: { text: action === "reset" ? `${LABELS[kind]}已恢复原始默认配置。` : `${LABELS[kind]}配置已保存并生效。` } }));
      await onSaved();
    } catch (error) {
      setNotices(current => ({ ...current, [kind]: { error: true, text: redact(error instanceof Error ? error.message : "保存失败，请重试。", draft.apiKey.trim()) } }));
    } finally {
      savingRef.current = false; setSaving(null); onBusyChange(false);
    }
  };

  const locked = busy || !!saving;
  return <section className="provider-section" aria-labelledby="provider-settings-title">
    <div className="provider-section-heading"><div><h2 id="provider-settings-title">模型连接，分别随你选择</h2><p>选择服务预设，再填写自己的模型与 Key。文本支持多种协议及本机服务；图片连接单独保存。</p></div><LockKeyhole size={17}/></div>
    {authRequired && <div className="provider-notice error" role="alert"><LockKeyhole size={14}/>{IS_LOCAL_APP ? <span>本机连接需要刷新，请重新读取模型配置后继续。</span> : <span>登录已过期。<a href="/signin-with-chatgpt?return_to=/" target="_top">重新登录</a> 后继续。</span>}</div>}
    {loading ? <div className="panel provider-loading" role="status"><LoaderCircle className="spin" size={18}/><span>正在读取已生效的模型配置…</span></div> : loadError ? <div className="panel"><div className="provider-notice error" role="alert"><CircleHelp size={15}/><span>{loadError}</span></div><button className="button secondary" disabled={locked} onClick={() => void load()}><RefreshCw size={13}/>重新读取</button></div> : settings && <div className="provider-grid">
      {KINDS.map(kind => {
        const provider = settings[kind], draft = drafts[kind], notice = notices[kind];
        const changingOrigin = changedOrigin(draft, provider);
        const storedForDraft = provider.keyConfigured && !changingOrigin && draft.local === !!provider.local;
        const preset = PROVIDER_PRESETS[kind].find(item => item.id === presets[kind]);
        const modelPlaceholder = kind === "image" ? draft.local ? "填写本机图片服务提供的模型名称" : "例如 nai-diffusion-5-full 或 gpt-image-1" : draft.protocol === "ollama" ? "填写已安装模型，如 gemma4" : presets[kind] === "lm-studio" ? "填写已加载模型的 ID" : "输入此服务可用的模型名称";
        const Icon = kind === "text" ? MessageCircle : ImagePlus;
        return <form className="panel provider-card" key={kind} onSubmit={event => { event.preventDefault(); void mutate(kind, "save"); }} autoComplete="off">
          <div className="provider-card-heading"><span className={`provider-icon ${kind}`}><Icon size={18}/></span><div><h3>{LABELS[kind]}</h3><p>{kind === "text" ? "招募、对话、记忆与共议" : "角色肖像、聊天图片与群聊配图"}</p></div><span className="provider-source">{provider.source === "default" ? "默认配置" : "自定义"}</span></div>
          <div className={`provider-key-status ${provider.keyConfigured || provider.local ? "configured" : "missing"}`}><span className={`status-dot ${provider.keyConfigured || provider.local ? "" : "off"}`}/><span>{provider.local ? `已保存本机配置 · ${provider.keyConfigured ? "Key 已配置" : "Key 为空"}` : provider.keyConfigured ? "已保存配置 · Key 已配置" : "尚未配置 Key"}</span></div>
          <div className="provider-field provider-preset-field"><label htmlFor={`${kind}-preset`}>服务预设<span>仅填入表单</span></label><select id={`${kind}-preset`} name={`${kind}-preset`} value={presets[kind]} onChange={event => choosePreset(kind, event.target.value)} disabled={locked}>{PROVIDER_PRESETS[kind].map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><p>{preset?.description} 选定后仍可修改，保存才生效。</p></div>
          <div className="provider-field"><label htmlFor={`${kind}-protocol`}>接口协议</label><select id={`${kind}-protocol`} name={`${kind}-protocol`} value={draft.protocol} onChange={event => edit(kind, "protocol", event.target.value as ProviderProtocol)} disabled={locked || kind === "image"}>{kind === "image" ? <option value="openai-chat">OpenAI Images 兼容</option> : PROVIDER_PROTOCOLS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><p>{kind === "image" ? "文生图使用 images/generations；参考图使用 images/edits，NovelAI 参考模型使用原生接口。" : PROVIDER_PROTOCOLS.find(item => item.value === draft.protocol)?.description}</p></div>
          <label className={`provider-option ${draft.local ? "active" : ""}`} htmlFor={`${kind}-local`}><input id={`${kind}-local`} name={`${kind}-local`} type="checkbox" checked={draft.local} disabled={locked} onChange={event => edit(kind, "local", event.target.checked)}/><span><strong>本机服务 · 只访问本机</strong><small>只允许 localhost、127.0.0.1 或 [::1]，需填写端口。可使用 HTTP，Key 可留空。</small></span></label>
          <div className="provider-field"><label htmlFor={`${kind}-base-url`}>API 地址</label><input id={`${kind}-base-url`} name={`${kind}-base-url`} type="text" inputMode="url" spellCheck={false} value={draft.baseUrl} onChange={event => edit(kind, "baseUrl", event.target.value)} placeholder={draft.local ? draft.protocol === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234/v1" : "https://api.example.com/v1"} maxLength={2048} required disabled={locked}/><p>{draft.local ? "访问运行此应用的电脑，请先启动对应的本机模型服务。其他局域网地址不可用。" : "可填域名或 HTTPS 基础地址，完整接口地址会自动归一。"}{draft.protocol === "ollama" ? " Ollama 原生地址无需 /v1。" : ""}</p></div>
          <div className="provider-field"><label htmlFor={`${kind}-model`}>{kind === "text" ? "模型名称" : "文生图模型"}</label><input id={`${kind}-model`} name={`${kind}-model`} value={draft.model} spellCheck={false} onChange={event => edit(kind, "model", event.target.value)} placeholder={modelPlaceholder} maxLength={200} required disabled={locked}/>{kind === "image" && <p>生成初始肖像，以及未引用角色头像的群聊图片。</p>}{kind === "text" && draft.local && <p>填写已安装或加载的真实模型标识；预设不会自动下载模型。</p>}</div>
          {kind === "text" && <label className={`provider-option provider-vision ${draft.visionEnabled ? "active" : ""}`} htmlFor="text-vision-enabled"><input id="text-vision-enabled" name="text-vision-enabled" type="checkbox" checked={draft.visionEnabled} disabled={locked} onChange={event => edit(kind, "visionEnabled", event.target.checked)}/><span><strong>启用图片识别（需模型支持）</strong><small>允许文本模型读取你发送的图片及你的头像。请确认当前模型支持视觉输入；不支持时关闭。</small></span></label>}
          {kind === "image" && <div className="provider-field"><label htmlFor="image-reference-model">参考图模型</label><input id="image-reference-model" name="image-reference-model" value={draft.referenceModel} spellCheck={false} onChange={event => edit(kind, "referenceModel", event.target.value)} placeholder="例如 nai-diffusion-4-5-full 或 gpt-image-1" maxLength={200} required disabled={locked}/><p>聊天发图与引用角色的群聊图片会上传头像参考，共用上方 API 地址及下方 Key。NovelAI 使用角色参考接口，GPT-image 等兼容模型使用 images/edits；接口不支持时会提示错误，保留重试机会。</p></div>}
          <div className="provider-field"><label htmlFor={`${kind}-api-key`}><KeyRound size={12}/>API Key{draft.local && <span>（可选）</span>}{storedForDraft && <span className="provider-key-hint">已保存 {provider.keyHint || "••••••••"}</span>}</label><input id={`${kind}-api-key`} name={`${kind}-api-key`} type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey} onChange={event => edit(kind, "apiKey", event.target.value)} placeholder={storedForDraft ? `已配置 ${provider.keyHint || "••••••••"} · 留空保留` : draft.local ? "本机服务未启用鉴权时可留空" : "输入此服务的 API Key"} maxLength={2048} disabled={locked}/><p>{draft.local ? storedForDraft ? "留空保留本机服务已保存的 Key；输入新 Key 替换。" : "本机可不填 Key。切换到本机时不会沿用原云服务的密钥。" : changingOrigin || provider.local ? "API 来源已更换，必须输入新地址对应的 Key。" : "留空保留已保存 Key；输入新 Key 替换。"}</p></div>
          {kind === "image" && <div className="provider-prompt-settings">
            <div className="provider-field"><label htmlFor="image-prompt-style">图片初始提示词模板</label><select id="image-prompt-style" name="image-prompt-style" value={draft.promptStyle} onChange={event => edit(kind, "promptStyle", event.target.value as ImagePromptStyle)} disabled={locked}>{IMAGE_PROMPT_STYLES.map(style => <option value={style.value} key={style.value}>{style.label}</option>)}</select><p>{IMAGE_PROMPT_STYLES.find(style => style.value === draft.promptStyle)?.description}</p><p>保存后用于肖像、私聊发图和群聊生图。模板选择不会更改模型名称。</p></div>
            {draft.promptStyle === "custom" && <div className="provider-field provider-template-field"><label htmlFor="image-custom-prompt">自定义模板<span>{draft.customPrompt.length} / {MAX_CUSTOM_IMAGE_PROMPT_CHARS}</span></label><textarea id="image-custom-prompt" name="image-custom-prompt" value={draft.customPrompt} onChange={event => edit(kind, "customPrompt", event.target.value)} placeholder={DEFAULT_CUSTOM_IMAGE_PROMPT} maxLength={MAX_CUSTOM_IMAGE_PROMPT_CHARS} rows={7} spellCheck={false} disabled={locked}/><div className="provider-template-variables" aria-label="可用模板变量">{IMAGE_PROMPT_VARIABLES.map(variable => <code key={variable}>{`{{${variable}}}`}</code>)}</div><p>prompt 是当前完整基础提示；name 为角色名，age 为年龄或制造日期，species / form 为种族与构型，appearance / traits 为外观与性格，request / userMessage 为当前画面与用户要求。通用配图没有人物时，人物变量留空。自定义模板可自由组织这些内容，建议保留 {"{{prompt}}"} 以带入完整上下文。</p>{!draft.customPrompt.trim() && <button type="button" className="button ghost" disabled={locked} onClick={() => edit(kind, "customPrompt", DEFAULT_CUSTOM_IMAGE_PROMPT)}>填入示例模板</button>}</div>}
            <details className="provider-template-preview"><summary>查看待保存的模板结构</summary><p>仅预览模板结构，不调用模型。实际生成时会填入当前人物与画面上下文。</p><pre>{renderImagePrompt("{{prompt}}", draft.promptStyle, draft.customPrompt, Object.fromEntries(IMAGE_PROMPT_VARIABLES.map(name => [name, `{{${name}}}`])))}</pre></details>
          </div>}
          {notice && <div className={`provider-notice ${notice.error ? "error" : "success"}`} role={notice.error ? "alert" : "status"}>{notice.error ? <CircleHelp size={14}/> : <Check size={14}/>}<span>{notice.text}</span></div>}
          <div className="provider-actions"><button type="button" className="button secondary" aria-label={kind === "text" ? "恢复文本默认" : "恢复生图默认"} disabled={locked} onClick={() => void mutate(kind, "reset")}>{saving?.kind === kind && saving.action === "reset" ? <LoaderCircle size={13} className="spin"/> : <RotateCcw size={13}/>}恢复默认</button><button type="submit" className="button primary" aria-label={kind === "text" ? "保存文本配置" : "保存生图配置"} disabled={locked}>{saving?.kind === kind && saving.action === "save" ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>}保存{kind === "text" ? "文本" : "生图"}配置</button></div>
        </form>;
      })}
    </div>}
    <p className="provider-footnote"><LockKeyhole size={12}/><span>Key 只提交并保存在服务端，不回显原文、不写入浏览器存储。保存配置不会调用模型；恢复默认会还原该卡片的原始服务端配置。</span></p>
    {busy && !saving && <p className="provider-busy"><LoaderCircle size={12} className="spin"/>当前操作完成后，即可修改模型连接。</p>}
  </section>;
}
