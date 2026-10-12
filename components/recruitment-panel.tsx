"use client";

import { Check, CircleHelp, Dice5, FileText, LoaderCircle, RefreshCw, Shuffle, Sparkles, Trash2 } from "lucide-react";
import type { RecruitmentBatch } from "@/lib/types";

const EXAMPLES = [
  "精灵：慢热、博学，擅长叙事但不擅执行",
  "仿生机器人：硅胶皮肤、拟人外观与独立人格",
  "机械机器人：外露关节与金属机体，个性自定",
  "兽族或灵体：写清来历、天赋与限制",
  "原创种族：自由描述形态、世界观与相处方式",
];

export function RecruitmentPanel({ brief, count, batch, busy, textReady, activeSlots, onBriefChange, onCountChange, onRecruit, onRandomBrief, onRandomRecruit, onRetry, onSkip }: {
  brief: string;
  count: number;
  batch?: RecruitmentBatch;
  busy: string | null;
  textReady: boolean;
  activeSlots: number[];
  onBriefChange: (value: string) => void;
  onCountChange: (value: number) => void;
  onRecruit: () => Promise<void>;
  onRandomBrief: () => Promise<void>;
  onRandomRecruit: () => Promise<void>;
  onRetry: (slot?: number) => Promise<void>;
  onSkip: (slot: number) => Promise<void>;
}) {
  const starting = busy === "recruit";
  const retrying = busy === "recruit.retry";
  const imagining = busy === "recruit.idea";
  const randomRecruiting = busy === "recruit.random";
  const succeeded = batch?.slots.filter(slot => slot.status === "succeeded").length || 0;
  const outstanding = batch?.slots.filter(slot => slot.status === 'pending' || slot.status === 'failed') || [];
  const skipped = batch?.slots.filter(slot => slot.status === 'skipped').length || 0;
  const failed = outstanding.filter(slot => slot.status === "failed");
  const locked = !!busy || !textReady;

  return <section className="recruitment-workspace" aria-label="寻访与生成结果">
    <form className="recruit-panel" onSubmit={event => { event.preventDefault(); void onRecruit(); }}>
      <label className="field-label" htmlFor="recruit-brief">你期待怎样的人物？</label>
      <textarea id="recruit-brief" value={brief} disabled={!!busy} onChange={event => onBriefChange(event.target.value)} maxLength={1800} placeholder="例如：一位有硅胶皮肤、自然头发和拟人表情的仿生机器人，外观近似人类，记录制造日期。也可以是外露机械结构的机器人、精灵或原创种族。希望她有具体身世、内心矛盾、自己的相处方式与明显短板。"/>
      <div className="quick-prompts">{EXAMPLES.map(text => <button type="button" key={text} disabled={!!busy} onClick={() => onBriefChange(text)}>{text}</button>)}</div>
      <div className="recruit-random-tools"><button type="button" className="button secondary small" disabled={locked} onClick={() => void onRandomBrief()}>{imagining ? <LoaderCircle size={14} className="spin"/> : <Dice5 size={14}/>} {imagining ? "正在构思人物设定…" : "随机人物设定"}</button><span className="form-hint">参考当前方向生成可编辑设定；留空即可自由创作。</span></div>
      <div className="recruit-options"><div className="recruit-count-field"><label htmlFor="recruit-count">这次寻访几位？</label><select id="recruit-count" value={count} disabled={!!busy} onChange={event => onCountChange(Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => index + 1).map(number => <option key={number} value={number}>{number} 份简历</option>)}</select></div><p>按你选择的数量生成详细人物档案，每份独立检查，并参照已有角色区分经历、性格、外貌细节与相处方式。失败项可以单独重试或移除。</p></div>
      <div className="form-footer"><span className="form-hint">本次 {count} 份 · 16 维能力 · 种族与形态不限<br/>随机设定调用一次文本 API；随机招募还会生成档案，按实际请求计费。</span><div className="recruit-start-actions"><button type="button" className="button secondary" disabled={locked} onClick={() => void onRandomRecruit()}>{randomRecruiting ? <LoaderCircle size={14} className="spin"/> : <Shuffle size={14}/>} {randomRecruiting ? "正在构思招募方向…" : `随机招募 · ${count} 份`}</button><button type="submit" className="button primary" disabled={locked || !brief.trim()}>{starting ? <LoaderCircle size={14} className="spin"/> : <Sparkles size={14}/>} {starting ? `正在生成 ${activeSlots.length} 份…` : `开始${batch ? "新" : ""}寻访 · ${count} 份`}</button></div></div>
      {(imagining || randomRecruiting) && <p className="recruit-connection-note" role="status"><LoaderCircle size={13} className="spin"/>{imagining ? "正在结合当前方向和已有公开角色，创作一份可编辑的需求。" : "正在创作随机需求，完成后会按当前数量开始寻访。"}</p>}
      {!textReady && <p className="recruit-connection-note"><CircleHelp size={13}/>请先在庭院设置连接文本模型，再开始寻访或重试。</p>}
      {batch && !batch.applied && <p className="recruit-new-note">下方批次还有未完成项。可以重新生成，或移除失败项后把成功档案放进候选池。开始新寻访会替换本批次记录。</p>}
    </form>

    {starting && <section className="recruit-loading" aria-live="polite" aria-busy="true"><div className="loading-inline"><LoaderCircle size={14} className="spin"/><span>正在生成 {activeSlots.length} 份详细档案。当前候选人保持原样，完成本批次后更新。</span></div><div className="recruit-skeleton-grid">{activeSlots.map(slot => <div className="recruit-skeleton" key={slot}><FileText size={18}/><span>第 {slot} 份 · 正在构建人物经历与能力</span></div>)}</div></section>}

    {batch && <section className={`recruit-batch ${batch.applied ? "complete" : "incomplete"}`} aria-labelledby="recruit-result-title">
      <header className="recruit-batch-heading"><div><span className="eyebrow">THE ENCOUNTERS IN PROGRESS</span><h2 id="recruit-result-title">{batch.applied ? "这次相遇，已准备好。" : "有些相遇，还差一步。"}</h2><p>{new Date(batch.updatedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} 更新 · 刷新后仍可继续</p></div><div className="recruit-batch-count"><strong>{succeeded}<small> / {batch.count}</small></strong><span>份简历通过检查</span></div></header>
      <details className="recruit-batch-brief"><summary>查看本批次寻访需求</summary><p>{batch.brief}</p></details>
      <div className={`recruit-result-notice ${batch.applied ? "success" : "warning"}`} role={failed.length && !retrying ? "alert" : "status"}>{batch.applied ? <Check size={15}/> : <CircleHelp size={15}/>}<p>{batch.applied ? `本批次已结束，${succeeded} 份成功档案已加入候选池${skipped ? `，${skipped} 份失败项已移除` : ""}。${succeeded ? "已经加入庭院的成员保留。" : "原有候选池保留。"}` : `已保留 ${succeeded} 份通过的档案，另有 ${outstanding.length} 份尚未通过。当前候选人尚未替换；补齐或移除失败项后，成功档案一起加入候选池。`}</p></div>
      <div className="recruit-slot-list">{batch.slots.map(slot => {
        const isActive = retrying && activeSlots.includes(slot.slot);
        const success = slot.status === "succeeded"; const removed = slot.status === "skipped";
        return <article className={`recruit-slot ${success ? "succeeded" : slot.status}`} key={slot.slot} aria-busy={isActive}>
          <div className="recruit-slot-heading"><span className="recruit-slot-number">{String(slot.slot).padStart(2, "0")}</span><div><h3>{success ? slot.candidate?.name || `第 ${slot.slot} 份档案` : `第 ${slot.slot} 份简历`}</h3><p>{success ? slot.candidate?.title || "人物档案已通过" : removed ? "已移除失败项，不再阻塞本批次" : slot.status === "pending" ? "尚待生成" : "未通过本次检查"}</p></div><span className={`recruit-slot-state ${success ? "success" : ""}`}>{isActive ? <><LoaderCircle size={12} className="spin"/>重新生成中</> : success ? <><Check size={12}/>{batch.applied ? "已加入候选" : "成功 · 已保留"}</> : <><CircleHelp size={12}/>{removed ? "已移除" : slot.status === "pending" ? "待生成" : "需重新生成"}</>}</span></div>
          {success ? <p className="recruit-slot-preserved">{batch.applied ? "本份结果已经应用到候选列表。" : "这份简历已保存，重新生成其他项不会重做本份，也不会为本份再次调用模型。"}</p> : removed ? <p className="recruit-slot-preserved">本项已移除，不再参与重试，也没有再次调用模型。</p> : <>
            {slot.issues.length > 0 ? <ul className="recruit-issues">{slot.issues.map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path || "整体结果"}</code><span>{issue.message || "该字段没有通过检查。"}</span></li>)}</ul> : <p className="recruit-slot-pending">{slot.status === "pending" ? "本份尚未完成生成，可由你手动开始。" : "本份生成未完成，可点击下方按钮重新生成。"}</p>}
            <div className="recruit-slot-actions"><span>{slot.attempts > 0 ? `已尝试 ${slot.attempts} 次` : "还没有完成的尝试"}{slot.errorCode ? ` · ${slot.errorCode}` : ""}</span>{slot.status === "failed" && <button type="button" className="button ghost small" disabled={!!busy} onClick={() => void onSkip(slot.slot)}><Trash2 size={12}/>移除第 {slot.slot} 份失败项</button>}<button type="button" className="button secondary small" disabled={locked} onClick={() => void onRetry(slot.slot)}>{isActive ? <LoaderCircle size={12} className="spin"/> : <RefreshCw size={12}/>}重新生成第 {slot.slot} 份</button></div>
          </>}
        </article>;
      })}</div>
      {!batch.applied && outstanding.length > 0 && <footer className="recruit-retry-footer"><p>仅重新生成未通过或待生成的档案。已成功的 {succeeded} 份保留。</p><button type="button" className="button primary" disabled={locked} onClick={() => void onRetry()}>{retrying ? <LoaderCircle size={13} className="spin"/> : <RefreshCw size={13}/>}重新生成未通过的 {outstanding.length} 份</button></footer>}
    </section>}
  </section>;
}
