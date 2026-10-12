"use client";

import { useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, ExternalLink, LoaderCircle, RotateCcw, X } from "lucide-react";
import { IMAGE_PROMPT_PRESETS, IMAGE_PROMPT_VARIABLES, MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS, MAX_IMAGE_POSITIVE_PROMPT_CHARS, MAX_IMAGE_NEGATIVE_PROMPT_CHARS, createImagePromptProfile, renderImagePromptTemplate, type ImagePromptPreset, type ImagePromptProfile, type ImagePromptProfiles, type ImagePromptSlot } from "@/lib/image-prompts";
import "./image-prompt-editor.css";

const cloneProfiles = (profiles: ImagePromptProfiles): ImagePromptProfiles => ({ generation: { ...profiles.generation }, reference: { ...profiles.reference } });

export function ImagePromptEditor({ value, model, referenceModel, busy, onClose, onSave }: {
  value: ImagePromptProfiles;
  model: string;
  referenceModel: string;
  busy: boolean;
  onClose: () => void;
  onSave: (profiles: ImagePromptProfiles) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => cloneProfiles(value));
  const [slot, setSlot] = useState<ImagePromptSlot>("generation");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const cache = useRef<Record<ImagePromptSlot, Partial<Record<ImagePromptPreset, ImagePromptProfile>>>>({ generation: {}, reference: {} });
  const profile = draft[slot];
  const preset = IMAGE_PROMPT_PRESETS.find(item => item.value === profile.preset)!;
  const locked = busy || saving;
  const edit = <K extends keyof ImagePromptProfile>(field: K, next: ImagePromptProfile[K]) => {
    setDraft(current => ({ ...current, [slot]: { ...current[slot], [field]: next } }));
    setSaveError("");
  };
  const selectPreset = (next: ImagePromptPreset) => {
    cache.current[slot][profile.preset] = { ...profile };
    setDraft(current => ({ ...current, [slot]: { ...(cache.current[slot][next] ?? createImagePromptProfile(next)) } }));
    setSaveError("");
  };
  const save = async () => {
    if (locked) return;
    setSaving(true); setSaveError("");
    try {
      if (await onSave(cloneProfiles(draft))) onClose();
      else setSaveError("尚未保存。请检查模型连接配置和当前操作状态，然后重试。");
    } catch {
      setSaveError("保存失败，草稿仍保留在此窗口，请重试。");
    } finally { setSaving(false); }
  };
  const previewVariables = Object.fromEntries(IMAGE_PROMPT_VARIABLES.map(name => [name, `{{${name}}}`]));

  return <Dialog.Root open onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="image-prompt-overlay"/>
      <Dialog.Content className="image-prompt-dialog" onEscapeKeyDown={event => { if (locked) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
        <div className="image-prompt-heading"><div><Dialog.Title>图片提示词配置</Dialog.Title><Dialog.Description>为文生图与参考图分别配置写法。窗口内的修改在保存后生效。</Dialog.Description></div><button type="button" className="icon-button" aria-label="关闭图片提示词配置" disabled={locked} onClick={onClose}><X size={19}/></button></div>
        <div className="image-prompt-tabs" role="tablist" aria-label="提示词用途">
          {(["generation", "reference"] as const).map(item => <button key={item} type="button" role="tab" id={`image-prompt-tab-${item}`} aria-controls="image-prompt-panel" aria-selected={slot === item} className={slot === item ? "active" : ""} disabled={locked} onClick={() => setSlot(item)}>{item === "generation" ? "文生图" : "参考图"}<small>{item === "generation" ? model : referenceModel}</small></button>)}
        </div>
        <div className="image-prompt-body" role="tabpanel" id="image-prompt-panel" aria-labelledby={`image-prompt-tab-${slot}`}>
          <div className="image-prompt-preset-row"><div className="provider-field"><label htmlFor="image-prompt-preset">提示策略预设</label><select id="image-prompt-preset" value={profile.preset} onChange={event => selectPreset(event.target.value as ImagePromptPreset)} disabled={locked}>{IMAGE_PROMPT_PRESETS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div><button type="button" className="button secondary" disabled={locked} onClick={() => { setDraft(current => ({ ...current, [slot]: createImagePromptProfile(profile.preset) })); setSaveError(""); }}><RotateCcw size={13}/>恢复所选预设</button></div>
          <p className="image-prompt-hint">{preset.description} 选择预设不会更改模型名称。{preset.documentation && <> <a href={preset.documentation} target="_blank" rel="noreferrer">官方写法参考 <ExternalLink size={11}/></a></>}</p>
          <label className={`provider-option ${profile.llmEnabled ? "active" : ""}`} htmlFor="image-prompt-llm"><input id="image-prompt-llm" type="checkbox" checked={profile.llmEnabled} disabled={locked} onChange={event => edit("llmEnabled", event.target.checked)}/><span><strong>让文本模型编写最终提示词</strong><small>已连接文本模型时，生成图片前把本次要求与人物信息整理成适合图片模型的正向、负面提示词。未连接时使用下方模板；预览和保存均不调用模型。</small></span></label>
          <div className="provider-field"><label htmlFor="image-prompt-instructions">给 LLM 的编写说明<span>{profile.instructions.length} / {MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS}</span></label><textarea id="image-prompt-instructions" value={profile.instructions} disabled={locked} rows={5} maxLength={MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS} spellCheck={false} onChange={event => edit("instructions", event.target.value)}/><p>决定文本模型如何取舍内容、使用标签或自然语言。关闭上方开关时不执行此说明。</p></div>
          <div className="provider-field"><label htmlFor="image-positive-prompt">正向提示词模板<span>{profile.positivePrompt.length} / {MAX_IMAGE_POSITIVE_PROMPT_CHARS}</span></label><textarea id="image-positive-prompt" value={profile.positivePrompt} disabled={locked} rows={5} maxLength={MAX_IMAGE_POSITIVE_PROMPT_CHARS} spellCheck={false} onChange={event => edit("positivePrompt", event.target.value)}/><p>{"{{prompt}}"} 带入当前完整画面描述。开启 LLM 时作为编写素材；关闭时直接替换变量。</p></div>
          <div className="provider-template-variables" aria-label="可用模板变量">{IMAGE_PROMPT_VARIABLES.map(variable => <code key={variable}>{`{{${variable}}}`}</code>)}</div>
          <p className="image-prompt-hint">name / age / species / form / appearance / traits 是人物资料；request / userMessage 是本次画面与用户要求。无人场景的人物变量为空。</p>
          <div className="provider-field"><label htmlFor="image-negative-prompt">负面提示词<span>{profile.negativePrompt.length} / {MAX_IMAGE_NEGATIVE_PROMPT_CHARS}</span></label><textarea id="image-negative-prompt" value={profile.negativePrompt} disabled={locked} rows={3} maxLength={MAX_IMAGE_NEGATIVE_PROMPT_CHARS} spellCheck={false} onChange={event => edit("negativePrompt", event.target.value)}/><p>支持上方同一组模板变量。NovelAI 使用独立负面词；GPT-image 与兼容模型会将这些约束转为提示文本。留空表示不添加预设负面词。</p></div>
          {(profile.preset === "nai5" || profile.preset === "nai45") && <p className="image-prompt-hint">NAI 预设在未要求印字时会额外添加无字约束；选择“自定义”可完全控制正负词。画面需要文字时，NovelAI 的 Text: 段会保留在最终提示词末尾；NAI 4.5 的文字渲染主要支持英文。</p>}
          <details className="image-prompt-preview"><summary>预览待保存的结构 · 不调用模型</summary><p>这是模板结构，实际最终提示词会随人物、场景与 LLM 输出变化。</p><h4>编写说明</h4><pre>{profile.llmEnabled ? profile.instructions || "（未填写额外说明）" : "已关闭 LLM 编写"}</pre><h4>正向模板</h4><pre>{renderImagePromptTemplate("{{prompt}}", profile.positivePrompt, previewVariables) || "（空）"}</pre><h4>负面提示词</h4><pre>{renderImagePromptTemplate("{{prompt}}", profile.negativePrompt, previewVariables, { preserveLettering: false }) || "（空）"}</pre></details>
        </div>
        <div className="image-prompt-footer">{saveError && <p role="alert" className="image-prompt-error">{saveError}</p>}<p>保存两套提示词及生图卡片中待保存的模型连接配置。</p><div><button type="button" className="button secondary" disabled={locked} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={locked} onClick={() => void save()}>{saving ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>}保存图片配置</button></div></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
