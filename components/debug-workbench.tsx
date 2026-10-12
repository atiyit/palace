"use client";

import { AUTH_ERROR, IS_LOCAL_APP } from "@/components/runtime-mode";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Braces, Check, ChevronDown, CircleHelp, Copy, Download, Eye, FileCode2, FlaskConical, History, Layers, LoaderCircle, LockKeyhole, Play, RefreshCw, RotateCcw, Save, Search, ShieldCheck, Upload, X } from "lucide-react";
import type { AppState } from "@/lib/types";
import type { DebugCatalog, DebugResult, DebugStage, DebugTrace } from "@/lib/debug-types";

const pretty = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "暂无结果";
const errorText = (error: unknown) => (error instanceof Error ? error.message : "操作未完成，请重试。").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[已隐藏 Key]");
function suggestedStage(id: string, current: DebugStage["id"]): DebugStage["id"] {
  if (id === 'user.profile') return 'user-profile';
  if (id === 'user.portrait.template') return 'user-portrait';
  if (id === "framework.system") return current;
  if (id === "task.instructions") return "task";
  if (id === "daily.system") return "daily";
  if (id === "daily.review") return "daily-review";
  if (id === "task.delivery") return "delivery";
  if (id === "task.delivery.review") return "delivery-review";
  if (id === 'task.group') return 'group';
  if (id === 'task.group.review') return 'group-review';
  if (id.startsWith("profile.enrich")) return "profile";
  if (id === "profile.review") return "reviewer";
  if (id.startsWith("portrait")) return "portrait";
  if (id === "chat.image.template") return current === "chat" ? "chat" : "chat-image";
  if (id.startsWith("strategy.review")) return "strategy-review";
  if (id.startsWith("reviewer")) return "reviewer";
  if (id.startsWith("recruiter") || id.startsWith("retry.recruit")) return "recruiter";
  return "actor";
}

function sampleFor(catalog: DebugCatalog | null, stage: DebugStage["id"], promptId: string) {
  if (promptId === "profile.review" && stage === "reviewer") {
    const profile = catalog?.stages.find(item => item.id === "profile")?.defaultInput;
    if (profile && typeof profile === "object" && !Array.isArray(profile)) {
      const input = profile as Record<string, unknown>;
      return { immutableCore: input.immutableCore, existingSpecies: input.existingSpecies, derivedProfile: input.derivedProfile, candidate: { species: input.existingSpecies, profile: input.derivedProfile } };
    }
  }
  return catalog?.stages.find(item => item.id === stage)?.defaultInput ?? {};
}

export function DebugWorkbench({ state, busy, onBusyChange }: {
  state: AppState;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<DebugCatalog | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部模块");
  const [showDefault, setShowDefault] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [stage, setStage] = useState<DebugStage["id"]>("actor");
  const [sampleInput, setSampleInput] = useState("{}");
  const [agentId, setAgentId] = useState(state.agents.find(a => a.hired && !a.archivedAt)?.id || state.agents.find(a => !a.archivedAt)?.id || "");
  const [taskId, setTaskId] = useState("");
  const [contextLoading, setContextLoading] = useState(false);
  const [maxTokens, setMaxTokens] = useState(1800);
  const [result, setResult] = useState<DebugResult | null>(null);
  const [resultContext, setResultContext] = useState<{ prompt: string; stage: string; drafts: number } | null>(null);
  const [resultTab, setResultTab] = useState<"trace" | "output">("trace");
  const operationRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const initialAgentId = useRef(agentId);
  const contextRequest = useRef(0);

  const loadCatalog = useCallback(async () => {
    setLoading(true); setError(""); setAuthRequired(false);
    try {
      const response = await fetch(`/api/debug${initialAgentId.current ? `?agentId=${encodeURIComponent(initialAgentId.current)}` : ""}`, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const data = await response.json() as DebugCatalog & { error?: string };
      if (!response.ok || !Array.isArray(data.prompts)) throw new Error(data.error || "暂时无法读取提示词目录。");
      setCatalog(data); setDrafts(Object.fromEntries(data.prompts.map(p => [p.id, p.text])));
      setSelectedId(current => data.prompts.some(p => p.id === current) ? current : data.prompts.find(p => p.id === "framework.system")?.id || data.prompts[0]?.id || "");
      const initialStage = data.stages.find(s => s.id === "actor") || data.stages[0];
      if (initialStage) { setStage(initialStage.id); setSampleInput(pretty(initialStage.defaultInput)); }
    } catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => { if (taskId && !state.tasks.some(task => task.id === taskId && task.status !== "completed")) setTaskId(""); }, [state.tasks, taskId]);

  const prompt = catalog?.prompts.find(p => p.id === selectedId);
  const currentDraft = prompt ? drafts[prompt.id] ?? prompt.text : "";
  const dirty = !!prompt && currentDraft !== prompt.text;
  const dirtyPrompts = useMemo(() => catalog?.prompts.filter(p => (drafts[p.id] ?? p.text) !== p.text) || [], [catalog, drafts]);
  const categories = useMemo(() => ["全部模块", ...new Set(catalog?.prompts.map(p => p.category) || [])], [catalog]);
  const filteredPrompts = useMemo(() => catalog?.prompts.filter(p => (category === "全部模块" || p.category === category) && `${p.id} ${p.title} ${p.category} ${p.description}`.toLowerCase().includes(query.toLowerCase().trim())) || [], [catalog, category, query]);
  const activeStage = catalog?.stages.find(s => s.id === stage);
  const locked = busy || !!operation || contextLoading;
  const modelReady = activeStage?.kind === "image" ? state.config.imageReady : state.config.textReady;

  const call = async (action: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch("/api/debug", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload, requestId: crypto.randomUUID() }),
    });
    if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok && !Array.isArray(data.trace)) throw new Error(typeof data.error === "string" ? data.error : "调试请求未完成，请重试。");
    return data;
  };
  const perform = async (name: string, work: () => Promise<void>) => {
    if (busy || operationRef.current || contextLoading) return;
    operationRef.current = true; setOperation(name); onBusyChange(true); setError(""); setNotice("");
    try { await work(); }
    catch (e) { setError(errorText(e)); }
    finally { operationRef.current = false; setOperation(""); onBusyChange(false); }
  };
  const saveCurrent = () => perform("save", async () => {
    if (!prompt) return;
    const data = await call("save", { id: prompt.id, text: currentDraft, agentId: agentId || undefined }) as unknown as DebugCatalog;
    if (!Array.isArray(data.prompts)) throw new Error("未收到保存后的目录，请重新读取确认。");
    setCatalog(data); setDrafts(current => ({ ...current, [prompt.id]: data.prompts.find(p => p.id === prompt.id)?.text ?? currentDraft }));
    setNotice(`「${prompt.title}」已保存，后续实际调用将使用此版本。`);
  });
  const resetCurrent = () => perform("reset", async () => {
    if (!prompt) return;
    const data = await call("reset", { id: prompt.id, agentId: agentId || undefined }) as unknown as DebugCatalog;
    if (!Array.isArray(data.prompts)) throw new Error("未收到重置后的目录。");
    setCatalog(data); setDrafts(current => ({ ...current, [prompt.id]: data.prompts.find(p => p.id === prompt.id)?.text || "" }));
    setNotice(`「${prompt.title}」已恢复默认，并清除了该项未保存草稿。`);
  });
  const resetAll = () => perform("resetAll", async () => {
    const data = await call("resetAll", { agentId: agentId || undefined }) as unknown as DebugCatalog;
    if (!Array.isArray(data.prompts)) throw new Error("未收到重置后的目录。");
    setCatalog(data); setDrafts(Object.fromEntries(data.prompts.map(p => [p.id, p.text]))); setConfirmResetAll(false);
    setNotice("全部提示词已恢复默认，未保存草稿已清除。");
  });
  const saveValidation = (contentRulesEnabled: boolean, restoreDefault = false) => perform("validation", async () => {
    const data = await call(restoreDefault ? "validation.reset" : "validation.save", { ...(!restoreDefault ? { contentRulesEnabled } : {}), agentId: agentId || undefined }) as unknown as DebugCatalog & { message?: string };
    if (!Array.isArray(data.prompts) || typeof data.validation?.contentRulesEnabled !== "boolean") throw new Error("未收到保存后的检查设置，请重新读取确认。");
    setCatalog(data);
    setNotice(data.message || (data.validation.contentRulesEnabled ? "内容规则检查已开启，后续生成使用默认检查。提示词草稿与当前测试输入保持不变。" : "内容规则检查已关闭，后续生成仍检查展示所需的结构与字段类型。提示词草稿与当前测试输入保持不变。"));
  });
  const run = (mode: "preview" | "run") => perform(mode, async () => {
    let input: unknown;
    try { input = JSON.parse(sampleInput); }
    catch { throw new Error("测试输入不是有效 JSON。请检查引号、逗号与括号。"); }
    const draftOverrides = Object.fromEntries(dirtyPrompts.map(p => [p.id, drafts[p.id]]));
    const data = await call(mode, { stage, promptId: selectedId, input, agentId: agentId || undefined, taskId: taskId || undefined, draftOverrides, maxTokens }) as unknown as DebugResult;
    if (!Array.isArray(data.trace)) throw new Error(data.error || "没有收到完整的调试结果。");
    setResult(data); setResultTab("trace");
    setResultContext({ prompt: prompt?.title || selectedId, stage: activeStage?.title || stage, drafts: dirtyPrompts.length });
    setNotice(mode === "preview" ? "请求已组装；没有调用外部模型，也没有保存草稿。" : data.status === "error" ? "本次沙盒运行已返回错误，请查看完整调用记录。" : "沙盒运行完成；结果没有写回成员、记忆、权重或事务。");
  });
  const selectStage = (id: DebugStage["id"], promptId = selectedId) => {
    setStage(id);
    setMaxTokens(id === "recruiter" || id === "profile" ? 4500 : 1800);
    setSampleInput(pretty(sampleFor(catalog, id, promptId)));
  };
  const selectPrompt = (id: string) => {
    setSelectedId(id); setShowDefault(false);
    selectStage(suggestedStage(id, stage), id);
  };
  const changeAgent = async (id: string) => {
    if (locked) return;
    const previousId = agentId, sequence = ++contextRequest.current;
    setAgentId(id); setContextLoading(true); setError("");
    try {
      const response = await fetch(`/api/debug${id ? `?agentId=${encodeURIComponent(id)}` : ""}`, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const data = await response.json() as DebugCatalog & { error?: string };
      if (!response.ok || !Array.isArray(data.stages)) throw new Error(data.error || "无法读取新人物的测试上下文。");
      if (sequence !== contextRequest.current) return;
      setCatalog(current => current ? { ...current, stages: data.stages, validation: data.validation } : current);
      initialAgentId.current = id;
      setSampleInput(pretty(sampleFor(data, stage, selectedId)));
      setNotice("已按参考人物更新各阶段示例与当前输入，所有提示词草稿保持不变。");
    } catch (e) {
      if (sequence === contextRequest.current) { const available = state.agents.some(a => a.id === previousId && !a.archivedAt); setAgentId(available ? previousId : ""); if (!available) initialAgentId.current = ""; setError(`${errorText(e)}已保留当前测试输入。`); }
    } finally { if (sequence === contextRequest.current) setContextLoading(false); }
  };
  useEffect(() => { if (!locked && agentId && !state.agents.some(a => a.id === agentId && !a.archivedAt)) void changeAgent(""); }, [state.agents, agentId, locked]);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setNotice("已复制到剪贴板。"); }
    catch { setError("复制失败，你仍可选中文字手动复制。"); }
  };
  const exportConfig = (includeDrafts: boolean) => {
    if (!catalog) return;
    const payload = { version: 1, exportedAt: new Date().toISOString(), includesUnsavedDrafts: includeDrafts, prompts: Object.fromEntries(catalog.prompts.map(p => [p.id, includeDrafts ? drafts[p.id] ?? p.text : p.text])) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `palace-prompts-${includeDrafts ? "draft" : "saved"}-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(includeDrafts ? "已导出当前草稿，未更改已保存的提示词。" : "已导出当前已保存的配置。");
  };
  const importConfig = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !catalog || locked) return;
    setError(""); setNotice("");
    try {
      if (file.size > 2_000_000) throw new Error("配置文件过大，请导入小于 2 MB 的 JSON。");
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("配置必须是 JSON 对象。");
      const record = parsed as Record<string, unknown>;
      const values = (record.prompts && typeof record.prompts === "object" && !Array.isArray(record.prompts) ? record.prompts : record) as Record<string, unknown>;
      const known = catalog.prompts.filter(p => Object.hasOwn(values, p.id));
      if (!known.length) throw new Error("文件中没有当前框架识别的提示词 ID。");
      const imported: Record<string, string> = {};
      for (const p of known) {
        const value = values[p.id];
        if (typeof value !== "string" || !value.trim()) throw new Error(`「${p.title}」必须是非空文本。`);
        if (value.length > catalog.limits.maxPromptChars) throw new Error(`「${p.title}」超过 ${catalog.limits.maxPromptChars} 字符限制。`);
        imported[p.id] = value;
      }
      setDrafts(current => ({ ...current, ...imported }));
      selectPrompt(known[0].id); setCategory("全部模块"); setQuery("");
      setNotice(`已导入 ${known.length} 项为临时草稿。可先预览或运行，确认后逐项保存；尚未更改线上配置。`);
    } catch (e) { setError(errorText(e)); }
  };

  return <div className="debug-workbench fade-in">
    <div className="page-header"><div><div className="eyebrow"><FlaskConical size={12}/>FRAMEWORK WORKBENCH</div><h1>让每一次思考，有迹可循。</h1><p>从人物行动到审校、招聘与记忆，查看、调整并测试整个框架的提示词。</p></div><div className="debug-header-status"><ShieldCheck size={14}/><span>独立沙盒 · 不回写庭院</span></div></div>
    {catalog && <section className={`debug-validation panel ${catalog.validation?.contentRulesEnabled === false ? "relaxed" : ""}`} aria-labelledby="debug-validation-title">
      <div className="debug-validation-copy"><div className="debug-validation-heading"><ShieldCheck size={16}/><h2 id="debug-validation-title">内容规则检查</h2><span>持续生效的调试设置</span></div><p id="debug-validation-description">开启时检查非机器人 21–10000 岁范围、档案文字与条目数量、能力分布。关闭后仍检查 JSON 结构、字段类型、有效日期、非负整数年龄，以及 16 项能力键与 0–100 整数。</p><p className="debug-validation-scope">保存后用于实际招募、失败简历重试、档案扩写和沙盒测试；不改写已有人物。提示词草稿与当前测试输入保持不变。</p></div>
      <div className="debug-validation-controls"><button type="button" role="switch" aria-checked={catalog.validation?.contentRulesEnabled !== false} aria-label="内容规则检查" aria-describedby="debug-validation-description" className="debug-validation-switch" disabled={locked} onClick={() => void saveValidation(catalog.validation?.contentRulesEnabled === false)}><span className="debug-validation-switch-track" aria-hidden="true"><span/></span><span>{operation === "validation" ? "保存中…" : catalog.validation?.contentRulesEnabled === false ? "已关闭" : "已开启"}</span></button>{catalog.validation?.contentRulesEnabled === false && <button type="button" className="button ghost" disabled={locked} onClick={() => void saveValidation(true, true)}><RotateCcw size={12}/>恢复默认检查</button>}</div>
    </section>}
    <div className="debug-toolbar"><div className="debug-toolbar-info"><Layers size={14}/>{catalog ? `${catalog.prompts.length} 个提示词槽位` : "加载提示词目录"}{dirtyPrompts.length > 0 && <span className="debug-dirty-chip">{dirtyPrompts.length} 项未保存</span>}</div><div className="debug-toolbar-actions"><input type="file" ref={fileInput} hidden accept="application/json,.json" onChange={event => void importConfig(event)}/><button className="button secondary small" disabled={locked || !catalog} onClick={() => fileInput.current?.click()}><Upload size={12}/>导入草稿</button><button className="button secondary small" disabled={!catalog} onClick={() => exportConfig(false)}><Download size={12}/>导出已保存</button><button className="button secondary small" disabled={!catalog} onClick={() => exportConfig(true)}><FileCode2 size={12}/>导出草稿</button><button className="button ghost" disabled={locked || !catalog} onClick={() => setConfirmResetAll(!confirmResetAll)}><RotateCcw size={12}/>重置全部</button></div></div>
    {authRequired && <div className="provider-notice error"><LockKeyhole size={14}/>{IS_LOCAL_APP ? <span>本机连接需要刷新，请重新读取框架目录后继续。</span> : <span>请<a href="/signin-with-chatgpt?return_to=/" target="_top">重新登录</a>后继续。</span>}</div>}
    {error && <div className="debug-message error" role="alert"><CircleHelp size={15}/><span>{error}</span><button aria-label="关闭调试错误" onClick={() => setError("")}><X size={14}/></button></div>}
    {notice && <div className="debug-message success" role="status"><Check size={15}/><span>{notice}</span><button aria-label="关闭调试提示" onClick={() => setNotice("")}><X size={14}/></button></div>}
    {confirmResetAll && <div className="debug-reset-confirm"><div><strong>将整个框架恢复为原始提示词？</strong><p>全部已保存改动与当前草稿会被替换。你可以先导出配置保留一份。</p></div><div><button className="button secondary small" disabled={locked} onClick={() => setConfirmResetAll(false)}>取消</button><button className="button primary small" disabled={locked} onClick={() => void resetAll()}>确认恢复全部默认</button></div></div>}
    {loading ? <div className="panel provider-loading"><LoaderCircle className="spin" size={18}/><span>正在读取完整框架目录…</span></div> : !catalog ? <div className="empty-state"><FlaskConical size={30}/><h3>提示词目录暂不可用</h3><p>请稍后重试，已保存的庭院配置不受影响。</p><button className="button secondary" disabled={locked} onClick={() => void loadCatalog()}><RefreshCw size={13}/>重新读取</button></div> : <>
      <div className="debug-editor-layout"><aside className="debug-catalog panel"><div className="debug-search"><Search size={14}/><input aria-label="搜索框架提示词" id="debug-prompt-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索提示词、模块、用途"/></div><select aria-label="提示词模块分类" value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select><div className="debug-prompt-list">{filteredPrompts.map(p => <button key={p.id} className={`debug-prompt-option ${p.id === selectedId ? "active" : ""}`} disabled={contextLoading || !!operation} onClick={() => selectPrompt(p.id)}><span className="debug-prompt-category">{p.category}</span><strong>{p.title}</strong><span className="debug-prompt-id">{p.id}</span><span className={`debug-prompt-state ${(drafts[p.id] ?? p.text) !== p.text ? "dirty" : ""}`}>{(drafts[p.id] ?? p.text) !== p.text ? "● 未保存草稿" : p.overridden ? "自定义 · 已保存" : "系统默认"}</span></button>)}{!filteredPrompts.length && <p className="debug-no-results">没有匹配的提示词，试试其他关键词。</p>}</div></aside>
        <section className="panel debug-editor">{prompt ? <><div className="debug-editor-heading"><div><span className="eyebrow">{prompt.category}</span><h2>{prompt.title}</h2><p>{prompt.description}</p></div><span className={`debug-version-badge ${dirty ? "dirty" : ""}`}>{dirty ? "未保存草稿" : prompt.overridden ? "已保存自定义" : "默认版本"}</span></div>
          <div className="debug-variable-row"><span>模板变量</span>{prompt.variables.length ? prompt.variables.map(v => <code key={v}>{v}</code>) : <small>此项没有动态占位符</small>}</div>
          <div className={`debug-text-editors ${showDefault ? "compare" : ""}`}><div className="debug-draft-column"><div className="debug-editor-label"><label htmlFor="debug-prompt-editor">当前编辑内容</label><span>{currentDraft.length.toLocaleString()} / {catalog.limits.maxPromptChars.toLocaleString()}</span></div><textarea id="debug-prompt-editor" value={currentDraft} onChange={e => setDrafts(current => ({ ...current, [prompt.id]: e.target.value }))} maxLength={catalog.limits.maxPromptChars} spellCheck={false} disabled={locked} aria-label={`${prompt.title}提示词编辑器`}/></div>{showDefault && <div className="debug-default-column"><div className="debug-editor-label"><span>系统默认 · 只读对照</span><button onClick={() => void copy(prompt.defaultText)} aria-label="复制默认提示词"><Copy size={12}/></button></div><textarea aria-label="默认提示词只读对照" value={prompt.defaultText} readOnly spellCheck={false}/></div>}</div>
          <div className="debug-editor-footer"><p>编辑内容先保留为草稿；保存后才影响后续正式调用。动态变量请保持原样。</p><div className="debug-editor-buttons"><button className="button secondary small" onClick={() => setShowDefault(!showDefault)}><History size={12}/>{showDefault ? "收起默认对照" : "对照默认"}</button><button className="button secondary small" disabled={locked} onClick={() => void resetCurrent()}><RotateCcw size={12}/>恢复本项默认</button><button className="button primary small" disabled={locked || !dirty || !currentDraft.trim()} onClick={() => void saveCurrent()}>{operation === "save" ? <LoaderCircle size={12} className="spin"/> : <Save size={12}/>}保存当前提示词</button></div></div>
        </> : <p className="panel-note">从目录中选择一个提示词开始。</p>}</section>
      </div>
      <section className="panel debug-sandbox"><div className="debug-sandbox-heading"><div><h2><FlaskConical size={17}/>先试一遍，再决定。</h2><p>临时草稿可直接参与测试，所有未保存改动只应用于本次沙盒。</p></div><span className="debug-sandbox-badge"><ShieldCheck size={12}/>不会改动真实成员与记忆</span></div>
        <div className="debug-run-settings"><div><label htmlFor="debug-stage">测试路径</label><select id="debug-stage" value={stage} disabled={locked} onChange={e => selectStage(e.target.value as DebugStage["id"])}>{catalog.stages.map(s => <option value={s.id} key={s.id}>{s.title}{s.kind === "image" ? " · 生图" : ""}</option>)}</select></div><div><label htmlFor="debug-agent">参考人物</label><select id="debug-agent" value={agentId} disabled={locked} onChange={e => void changeAgent(e.target.value)}><option value="">默认示例人物</option>{state.agents.filter(a => !a.archivedAt).map(a => <option key={a.id} value={a.id}>{a.name}{a.hired ? " · 庭院成员" : " · 候选人"}</option>)}</select></div>{stage === "task" ? <div><label htmlFor="debug-task">参考事务</label><select id="debug-task" value={taskId} disabled={locked} onChange={e => setTaskId(e.target.value)}><option value="">新建临时示例事务</option>{state.tasks.filter(task => task.status !== "completed").map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div> : stage === "chat" ? <div><label>输出预算</label><div className="debug-fixed-budget">完整链路使用各生产步骤的固定预算</div></div> : <div><label htmlFor="debug-max-tokens">最大输出 Token{stage==="recruiter"?" · 单人招聘建议 4500":stage==="profile"?" · 扩写建议 4500":""}</label><input id="debug-max-tokens" type="number" min={128} max={8000} step={128} value={maxTokens} disabled={locked} onChange={e => setMaxTokens(Math.max(128, Math.min(8000, Number(e.target.value) || 128)))}/></div>}</div>
        <div className="debug-sample-header"><label htmlFor="debug-input-json"><Braces size={13}/>测试输入 JSON</label><button className="button ghost" disabled={locked} onClick={() => activeStage && setSampleInput(pretty(activeStage.defaultInput))}>重置为示例</button></div><textarea id="debug-input-json" className="debug-input-json" value={sampleInput} onChange={e => setSampleInput(e.target.value)} spellCheck={false} maxLength={40000} disabled={locked}/>
        <div className="debug-test-kind"><ShieldCheck size={13}/><span>{stage === "chat" || stage === "task" ? "完整链路沙盒：包含人物行动、审校与按需重试；私聊可按当前要求生成临时图片，输出预算沿用生产步骤。" : "单阶段原始测试：仅调用所选模型阶段。日常和交付阶段只返回提议或工具指令，不执行真实工具，也不写入职位与文件。JSON 解析成功，不代表已通过人设一致性检查。"}</span></div>{contextLoading&&<div className="loading-inline"><LoaderCircle size={13} className="spin"/>正在更新参考人物与示例上下文…</div>}<div className="debug-run-note"><CircleHelp size={14}/><span>预览只组装请求，不调用模型。真实运行会调用你的 API 并产生费用，完整链路可能包含多次调用。沙盒不会修改成员、记忆、权重或事务记录，生成图片只在本次结果中展示。</span></div><p className="debug-stage-hint">本次测试携带 {dirtyPrompts.length} 项未保存草稿。单步测试会自动匹配所选提示词的阶段；完整私聊或事务链路只在实际触发对应阶段时使用该槽位。</p>
        <div className="debug-run-actions"><span>{!modelReady ? "当前路径的模型尚未配置，仍可预览请求。" : "使用庭院设置中当前生效的模型连接。"}</span><div><button className="button secondary" disabled={locked || !prompt} onClick={() => void run("preview")}>{operation === "preview" ? <LoaderCircle size={14} className="spin"/> : <Eye size={14}/>}预览组装请求</button><button className="button primary" disabled={locked || !prompt || !modelReady} onClick={() => void run("run")}>{operation === "run" ? <LoaderCircle size={14} className="spin"/> : <Play size={14}/>}真实运行沙盒</button></div></div>
      </section>
      {(result || operation === "run" || operation === "preview") && <section className="panel debug-results"><div className="debug-results-heading"><div><h2>调用的每一步，都在这里。</h2>{resultContext && <p>{resultContext.prompt} · {resultContext.stage} · {resultContext.drafts} 项草稿</p>}</div>{result && <span className={`debug-result-status ${result.status}`}>{result.status === "preview" ? "仅预览" : result.status === "ok" ? "运行完成" : "运行返回错误"} · {(result.elapsedMs / 1000).toFixed(2)} 秒</span>}</div>{(operation === "run" || operation === "preview") && <div className="loading-inline"><LoaderCircle size={15} className="spin"/>{operation === "preview" ? "正在组装准确请求…" : "正在执行真实模型调用，等待完整链路返回…"}</div>}{result && <><div className="debug-result-tabs"><button className={resultTab === "trace" ? "active" : ""} onClick={() => setResultTab("trace")}>完整调用轨迹 · {result.trace.length}</button><button className={resultTab === "output" ? "active" : ""} onClick={() => setResultTab("output")}>最终结果</button><button className="debug-copy-result" onClick={() => void copy(JSON.stringify(result, null, 2))}><Copy size={12}/>复制全部 JSON</button></div>{result.error && <div className="debug-message error"><CircleHelp size={14}/><span>{result.error}</span></div>}{resultTab === "trace" ? <div className="debug-traces">{result.trace.map((trace, i) => <TraceCard key={`${i}-${trace.id}`} trace={trace} index={i} onCopy={copy}/>)}{!result.trace.length && <p className="panel-note">没有执行模型调用；请查看错误或最终结果。</p>}</div> : <div className="debug-final-output">{result.imageDataUrl && /^data:image\/(png|jpeg|webp);base64,/i.test(result.imageDataUrl) && <img src={result.imageDataUrl} alt="沙盒生成的图片，未写入正式存储"/>}<pre>{result.output === undefined ? result.mode === "preview" ? "预览没有模型输出，请查看完整调用轨迹中的组装请求。" : "未返回最终结构化结果，请查看调用轨迹中的原始输出。" : pretty(result.output)}</pre></div>}<p className="debug-persisted-note"><ShieldCheck size={12}/>此结果仅用于调试。人物、记忆、推荐权重、真实事务均未写入。</p></>}</section>}
      {busy && !operation && <div className="debug-message"><LoaderCircle size={14} className="spin"/><span>当前庭院操作完成后，可保存提示词或运行沙盒。草稿保留在本页面，切换导航不会丢失。</span></div>}
    </>}
  </div>;
}

function TraceCard({ trace, index, onCopy }: { trace: DebugTrace; index: number; onCopy: (text: string) => Promise<void> }) {
  const [tab, setTab] = useState<"request" | "raw" | "parsed">("request");
  const request = trace.messages ? { model: trace.model, endpoint: trace.endpoint, protocol: trace.protocol, messages: trace.messages, ...(trace.inputImages?.length ? { inputImages: trace.inputImages, imageNote: '真实图片随请求发送；调试记录仅显示来源及大小，不复制像素。' } : {}) } : { model: trace.model, endpoint: trace.endpoint, prompt: trace.prompt, ...(trace.negativePrompt !== undefined ? { negativePrompt: trace.negativePrompt } : {}), ...(trace.reference ? { reference: trace.reference } : {}) };
  const value = tab === "request" ? JSON.stringify(request, null, 2) : tab === "raw" ? trace.raw || "本步骤没有原始模型输出。预览不会调用模型。" : trace.parsed === undefined ? "本步骤没有解析结果。可切换到原始输出查看。" : pretty(trace.parsed);
  return <details className="debug-trace" open={index === 0}><summary><span className="debug-trace-number">{(index + 1).toString().padStart(2, "0")}</span><div><strong>{trace.id}</strong><span>{trace.kind === "image" ? "图片模型" : "文本模型"} · {trace.model}</span></div><span className={`debug-trace-status ${trace.status}`}>{trace.status === "preview" ? "请求已组装" : trace.status === "ok" ? "成功" : trace.status === "error" ? "错误" : "等待"}</span><ChevronDown size={14}/></summary><div className="debug-trace-body"><div className="debug-trace-meta"><span>Token：{trace.tokens ?? "服务未返回"}</span><span>耗时：{trace.elapsedMs === undefined ? "—" : `${(trace.elapsedMs / 1000).toFixed(2)} 秒`}</span><span>结束原因：{trace.finishReason || "—"}</span></div>{trace.error && <div className="debug-message error"><CircleHelp size={13}/><span>{trace.error}</span></div>}<div className="debug-trace-tabs"><div>{[{ id: "request" as const, title: "实际组装请求" }, { id: "raw" as const, title: "原始模型输出" }, { id: "parsed" as const, title: "解析结果" }].map(item => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.title}</button>)}</div><button aria-label={`复制第${index + 1}步${tab === "request" ? "请求" : tab === "raw" ? "原始输出" : "解析结果"}`} onClick={() => void onCopy(value)}><Copy size={12}/></button></div><pre>{value}</pre></div></details>;
}
