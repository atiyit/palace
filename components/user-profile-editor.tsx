"use client";

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Check, CircleHelp, ImagePlus, LoaderCircle, RotateCcw, Save, Sparkles, Trash2, Upload, UserRound, WandSparkles } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { MAX_USER_IMAGE_BYTES, USER_PROFILE_LIMITS, userAvatarUrl, type UserProfileDraft } from '@/lib/user-profile';

const initialDraft = (state: AppState): UserProfileDraft => ({ name: state.userProfile?.name || '', description: state.userProfile?.description || '', preferences: state.userProfile?.preferences || '' });
interface ProfileResponse { state?: AppState; draft?: UserProfileDraft; message?: string; error?: string; }

export function UserProfileEditor({ state, busy, onState, onBusyChange }: {
  state: AppState; busy: boolean; onState: (state: AppState) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<UserProfileDraft>(() => initialDraft(state));
  const [brief, setBrief] = useState('');
  const [avatarPrompt, setAvatarPrompt] = useState(state.userProfile?.avatarPrompt || '');
  const [operation, setOperation] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const operationRef = useRef(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const profile = state.userProfile;
  const savedText = JSON.stringify(initialDraft(state));
  const savedTextRef = useRef(savedText);
  const draftRef = useRef(draft); draftRef.current = draft;
  const avatar = userAvatarUrl(profile?.avatar);
  const locked = busy || !!operation || !!state.pendingCleanup?.length;
  const dirty = JSON.stringify(draft) !== savedText;
  useEffect(() => {
    if (savedTextRef.current !== savedText) {
      // 主人，上传头像时有可能顺带创建出第一份保存的资料呢——我会先确认草稿和旧快照一致才同步，绝不擅自丢掉主人正在编辑的文字内容。
      if (JSON.stringify(draftRef.current) === savedTextRef.current) setDraft(JSON.parse(savedText));
      savedTextRef.current = savedText;
    }
  }, [savedText]);
  useEffect(() => setAvatarFailed(false), [avatar]);

  const perform = async (action: string, payload: Record<string, unknown> | (() => Promise<Record<string, unknown>>) = {}) => {
    if (locked || operationRef.current) return;
    operationRef.current = true; setOperation(action); setError(''); setNotice(''); onBusyChange?.(true);
    try {
      const values = typeof payload === 'function' ? await payload() : payload;
      const response = await fetch('/api/user-profile', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values, requestId: crypto.randomUUID() }) });
      const result = await response.json() as ProfileResponse;
      if (!response.ok) throw new Error(result.error || '资料操作失败，请稍后重试。');
      if (result.state) onState(result.state);
      if (action === 'save' && result.state) setDraft(initialDraft(result.state));
      if (result.draft) setDraft(result.draft);
      if (action === 'clear') { setDraft({ name: '', description: '', preferences: '' }); setAvatarPrompt(''); setConfirmClear(false); }
      setNotice(result.message || '已完成。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法完成操作，请稍后重试。'); }
    finally { operationRef.current = false; setOperation(''); onBusyChange?.(false); }
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || locked) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > MAX_USER_IMAGE_BYTES) {
      setError('请选择10 MiB以内的 PNG、JPEG 或 WebP 图片。'); return;
    }
    await perform('avatar.upload', async () => {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error('无法读取图片，请重新选择。')); reader.readAsDataURL(file);
      });
      return { dataBase64: data, contentType: file.type };
    });
  };

  return <section className="user-profile-editor panel" aria-labelledby="user-profile-heading">
    <header className="up-heading"><div><span className="eyebrow">YOUR PRESENCE</span><h2 id="user-profile-heading"><UserRound size={19}/>让她们认识你</h2><p>写下你愿意分享的自我介绍、身份设定和交流偏好。保存后，成员会在聊天与共议中参考。</p></div>{profile && <span className="up-saved"><Check size={12}/>已保存资料</span>}</header>
    <div className="up-layout"><div className="up-avatar-column">
      <div className="up-avatar-preview">{avatar && !avatarFailed ? <img src={avatar} alt="你的头像" onError={() => setAvatarFailed(true)}/> : <><UserRound size={46}/><span>你的头像</span></>}</div>
      <input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => void upload(event)} disabled={locked}/>
      <button type="button" className="button secondary" disabled={locked} onClick={() => uploadInput.current?.click()}>{operation === 'avatar.upload' ? <LoaderCircle size={14} className="spin"/> : <Upload size={14}/>}上传头像</button>
      <p className="up-hint">PNG / JPEG / WebP · 最多10 MiB<br/>上传后会移除图片中的附加元数据。</p>
      {avatar && <button type="button" className="button ghost small" disabled={locked} onClick={() => void perform('avatar.remove')}><Trash2 size={12}/>移除头像</button>}
      <div className="up-avatar-generator"><label htmlFor="user-avatar-prompt">头像构想</label><textarea id="user-avatar-prompt" value={avatarPrompt} maxLength={USER_PROFILE_LIMITS.avatarPrompt} rows={3} disabled={locked} onChange={event => setAvatarPrompt(event.target.value)} placeholder="例如：短发、圆框眼镜，温暖的二次元头像。"/><button type="button" className="button secondary" disabled={locked || !state.config.imageReady || !(avatarPrompt.trim() || profile?.description)} onClick={() => void perform('avatar.generate', { prompt: avatarPrompt })}>{operation === 'avatar.generate' ? <LoaderCircle size={14} className="spin"/> : <ImagePlus size={14}/>}生成我的头像</button><p className="up-hint">使用已保存的自我介绍和当前生图模型，生成后直接替换头像。{!state.config.imageReady ? '请先配置生图 API。' : ''}</p></div>
    </div><div className="up-form-column">
      <form className="up-draft-maker" onSubmit={event => { event.preventDefault(); void perform('draft', { brief }); }}><label htmlFor="user-profile-brief"><Sparkles size={14}/>一句话起草资料</label><div><textarea id="user-profile-brief" value={brief} maxLength={USER_PROFILE_LIMITS.brief} rows={2} disabled={locked} onChange={event => setBrief(event.target.value)} placeholder="例如：叫我阿遥，喜欢科幻和设计，想与她们一起做有趣的小项目。"/><button type="submit" className="button secondary" disabled={locked || !state.config.textReady || !brief.trim()}>{operation === 'draft' ? <LoaderCircle size={14} className="spin"/> : <WandSparkles size={14}/>}生成草稿</button></div><p className="up-hint">AI只起草你想表达的资料。你可以修改后再保存，草稿不会自动交给成员。{!state.config.textReady ? '请先配置文本 API。' : ''}</p></form>
      <form className="up-fields" onSubmit={event => { event.preventDefault(); void perform('save', { ...draft, preferences: draft.preferences || '' }); }}>
        <label htmlFor="user-profile-name">希望她们怎样称呼你<input id="user-profile-name" value={draft.name} maxLength={USER_PROFILE_LIMITS.name} disabled={locked} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="你的名字、昵称或角色称呼"/></label>
        <label htmlFor="user-profile-description">自我介绍<textarea id="user-profile-description" value={draft.description} maxLength={USER_PROFILE_LIMITS.description} rows={6} disabled={locked} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} placeholder="你的兴趣、希望扮演的身份、正在做的事，以及希望她们了解的背景。"/><span>{draft.description.length} / {USER_PROFILE_LIMITS.description}</span></label>
        <label htmlFor="user-profile-preferences">交流偏好<textarea id="user-profile-preferences" value={draft.preferences || ''} maxLength={USER_PROFILE_LIMITS.preferences} rows={3} disabled={locked} onChange={event => setDraft(current => ({ ...current, preferences: event.target.value }))} placeholder="例如：喜欢直接而具体的回答；有不同意见时请说明理由；闲聊时可以幽默一点。"/></label>
        <div className="up-save-row"><span>{dirty ? '有尚未保存的修改' : profile ? `更新于 ${new Date(profile.updatedAt).toLocaleString('zh-CN')}` : '资料由你决定，可以随时修改或清空。'}</span><div>{dirty && <button type="button" className="button ghost small" disabled={locked} onClick={() => { setDraft(initialDraft(state)); setNotice('已恢复到保存的资料。'); setError(''); }}><RotateCcw size={12}/>撤销修改</button>}<button type="submit" className="button primary" disabled={locked || !(draft.name.trim() || draft.description.trim() || draft.preferences?.trim())}>{operation === 'save' ? <LoaderCircle size={14} className="spin"/> : <Save size={14}/>}保存我的资料</button></div></div>
      </form>
      {profile && <div className="up-clear-row">{confirmClear ? <><p>清空自我介绍和头像？已经发生的聊天记录会保留。</p><button type="button" className="button secondary small" disabled={locked} onClick={() => void perform('clear')}>确认清空</button><button type="button" className="button ghost small" disabled={locked} onClick={() => setConfirmClear(false)}>取消</button></> : <button type="button" className="button ghost small" disabled={locked} onClick={() => setConfirmClear(true)}><Trash2 size={12}/>清空我的资料</button>}</div>}
    </div></div>
    {error && <p className="up-notice error" role="alert"><CircleHelp size={14}/>{error}</p>}{notice && <p className="up-notice" role="status"><Check size={14}/>{notice}</p>}
    <style>{`.user-profile-editor{padding:25px;margin-bottom:22px;min-width:0;border-color:#b7a0df20;background:linear-gradient(155deg,#202028,#191a20 70%)}.up-heading{display:flex;justify-content:space-between;gap:16px;margin-bottom:24px}.up-heading h2{color:#dccbe7;display:flex;align-items:center;gap:9px;font-size:21px;margin:7px 0 10px}.up-heading p{font-size:12px;color:var(--muted);line-height:1.8;max-width:660px}.up-saved{display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;color:var(--green);align-self:flex-start;margin-top:23px}.up-layout{display:grid;grid-template-columns:210px minmax(0,1fr);gap:30px}.up-avatar-column{display:flex;flex-direction:column;gap:10px;align-items:stretch}.up-avatar-preview{width:100%;aspect-ratio:1;border:1px solid #b7a0df26;border-radius:20px;background:linear-gradient(145deg,#25232d,#191a20);overflow:hidden;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:11px;color:#c2afd0}.up-avatar-preview img{height:100%;width:100%;object-fit:cover}.up-avatar-preview span{font-size:12px}.up-hint{font-size:11px;color:#a99cb5;line-height:1.75;margin:0}.up-avatar-generator{margin-top:12px;border-top:1px solid #b7a0df20;padding-top:17px;display:flex;flex-direction:column;gap:10px}.up-avatar-generator label,.up-draft-maker label{color:#c2afd0;font-size:12px;font-weight:600}.up-draft-maker{background:#b7a0df08;border:1px solid #b7a0df20;border-radius:12px;padding:16px;margin-bottom:22px}.up-draft-maker label{display:flex;align-items:center;gap:6px;margin-bottom:10px}.up-draft-maker>div{display:flex;gap:10px;align-items:stretch;margin-bottom:8px}.up-draft-maker textarea{min-width:0;flex:1}.up-draft-maker button{white-space:nowrap;align-self:center}.up-fields{display:flex;flex-direction:column;gap:18px}.up-fields>label{color:#c2afd0;display:flex;flex-direction:column;gap:8px;font-size:12px;font-weight:500}.up-fields>label>span{text-align:right;font-size:11px;font-weight:400;color:#a99cb5}.user-profile-editor textarea,.user-profile-editor input:not([type=file]){width:100%;box-sizing:border-box;border:1px solid #b7a0df28;border-radius:10px;padding:11px 12px;color:var(--text);background:#111217;font-size:12px;line-height:1.75;outline:none;resize:vertical;font-family:inherit}.user-profile-editor textarea:focus,.user-profile-editor input:focus{border-color:var(--purple);box-shadow:0 0 0 3px #b89ac617}.up-save-row{display:flex;justify-content:space-between;align-items:center;gap:12px}.up-save-row>span{font-size:11px;color:#a99cb5}.up-save-row>div{display:flex;align-items:center;gap:8px}.up-clear-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:15px}.up-clear-row p{font-size:11px;color:var(--danger)}.up-notice{overflow-wrap:anywhere;display:flex;align-items:center;gap:7px;font-size:12px;color:#b4d0ba;background:#93b6a110;border-radius:10px;padding:12px;margin-top:18px;line-height:1.7}.up-notice.error{color:var(--danger);background:#e9aaa40c}@media(max-width:760px){.user-profile-editor{padding:18px}.up-layout{grid-template-columns:1fr;gap:25px}.up-avatar-column{max-width:280px;width:100%;margin:0 auto}.up-heading{display:block}.up-saved{margin-top:10px}.up-draft-maker>div{flex-direction:column}.up-draft-maker button{align-self:flex-end}.up-save-row{align-items:flex-start;flex-direction:column}.up-save-row>div{width:100%;justify-content:flex-end}}`}</style>
  </section>;
}
