"use client";

import { BadgeCheck, Check, ChevronRight, Coffee, LoaderCircle, MessageCircle, Pause, Play, Sparkles, Users, X } from "lucide-react";
import { useState } from "react";
import type { Agent, AppState, DailyEvent, RoleProposal } from "@/lib/types";
import { RichText } from "@/components/rich-text";

export const DAILY_LABELS: Record<DailyEvent["kind"], string> = {
  chat: "日常闲谈", support: "表达支持", disagree: "保留意见", "propose-role": "提出职位", "endorse-role": "认可职位", "decline-role": "婉拒职位",
};
const stamp = (date: string) => new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function roleConsensus(proposal: RoleProposal, agents: Agent[]) {
  const active = new Set(agents.filter(a => a.hired && !a.archivedAt).map(a => a.id));
  const holder = agents.find(a => a.id === proposal.holderId);
  const holderAccepted = active.has(proposal.holderId) && proposal.supporterIds.includes(proposal.holderId);
  const formed = holderAccepted && proposal.supporterIds.some(id => id !== proposal.holderId && active.has(id));
  const isOfficial = active.has(proposal.holderId) && proposal.status === "approved" && holder?.appointment?.title === proposal.title && holder.appointment.duties === proposal.duties;
  return { formed, isOfficial, holderAccepted };
}

export function hasPrivateConsensus(proposal: RoleProposal, agents: Agent[]) {
  const { formed, isOfficial } = roleConsensus(proposal, agents);
  return formed && !isOfficial;
}

export function PrivateRoleBadges({ agent, state }: { agent: Agent; state: AppState }) {
  const roles = (state.roleProposals || []).filter(p => p.holderId === agent.id && hasPrivateConsensus(p, state.agents));
  if (!roles.length) return null;
  return <div className="private-role-badges">{roles.map(role => <span key={role.id} className="tag private-role" title={role.duties}><Users size={11}/>私下共识 · {role.title}</span>)}</div>;
}

export function RoleProposals({ state, busy, onReview }: {
  state: AppState; busy: boolean; onReview: (id: string, decision: "approve" | "private" | "reject") => Promise<unknown>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const all = [...(state.roleProposals || [])].reverse();
  const proposals = all.filter(p => {
    const holder = state.agents.find(a => a.id === p.holderId);
    return holder?.hired && !holder.archivedAt && (showHistory || p.status === "pending" || p.status === "private" || hasPrivateConsensus(p, state.agents));
  });
  return <section className="panel role-proposals" aria-label="自发职位提案">
    <div className="daily-section-heading"><h2 className="panel-title"><Sparkles size={15}/>她们提出的职位</h2><button className="button ghost small" onClick={() => setShowHistory(!showHistory)} aria-pressed={showHistory}>{showHistory ? "只看待审与私下" : "查看审阅历史"}<ChevronRight size={12}/></button></div>
    <p className="panel-note">职位来自她们自己的交流。本人和另一位在场成员都认可时，可形成私下共识；由你批准后才成为正式任命。不予正式批准，也会保留她们之间的认可。</p>
    {proposals.length ? <div className="role-proposal-list">{proposals.map(p => {
      const holder = state.agents.find(a => a.id === p.holderId)!;
      const proposer = state.agents.find(a => a.id === p.proposerId);
      const { formed, isOfficial, holderAccepted } = roleConsensus(p, state.agents);
      const consensus = formed && !isOfficial;
      const supporters = p.supporterIds.map(id => state.agents.find(a => a.id === id)).filter((a): a is Agent => !!a && a.hired && !a.archivedAt);
      const reviewable = p.status !== "approved";
      const label = isOfficial ? "当前正式任命" : p.status === "approved" ? formed ? "曾获批准 · 当前为私下共识" : "曾获批准 · 已非现任" : p.status === "rejected" ? formed ? "未获正式批准 · 私下共识" : "未获正式批准" : formed ? "私下共识已形成" : p.status === "private" ? "私下共识暂未满足" : "尚未形成共识";
      return <article className={`role-proposal ${consensus ? "consensus" : ""}`} key={p.id}>
        <div className="role-proposal-heading"><div><span className="eyebrow">{holder.name}</span><h3>{p.title}</h3></div><span className={`role-status ${isOfficial ? "approved" : consensus ? "private" : p.status === "rejected" ? "rejected" : "pending"}`}>{label}</span></div>
        <dl className="role-proposal-detail"><dt>职责</dt><dd>{p.duties}</dd><dt>缘由</dt><dd>{p.reason}</dd></dl>
        <p className="role-proposal-origin">{proposer?.name || "已离开的成员"}提出 · {stamp(p.createdAt)}</p>
        <p className="role-proposal-support">在场支持者：{supporters.map(a => a.name).join("、") || "尚无"}{!holderAccepted ? " · 本人尚未接受" : !formed ? " · 等待其他成员认可" : ""}</p>
        {reviewable && <><p className="role-approval-note">{!formed ? "需要本人同意、且至少另一位在场成员支持，才能批准任命或确认保留私下共识。" : holder.appointment ? `批准后将替换${holder.name}当前的「${holder.appointment.title}」正式职位。` : `批准后将正式任命${holder.name}为「${p.title}」。`}</p><div className="role-proposal-actions"><button className="button primary small" disabled={busy || !formed} onClick={() => void onReview(p.id, "approve")}><BadgeCheck size={13}/>批准任命</button><button className="button secondary small" disabled={busy || !formed || p.status === "private"} onClick={() => void onReview(p.id, "private")}><Users size={13}/>{p.status === "private" ? "已保留私下" : "保留私下"}</button><button className="button ghost small" disabled={busy || p.status === "rejected"} onClick={() => void onReview(p.id, "reject")}><X size={12}/>不予正式批准</button></div></>}
        {p.status === "approved" && !isOfficial && <p className="role-review-note">这项正式任命已被调整或撤销。如需重新任命，请在成员档案的「职位」中设置。</p>}
        {p.reviewNote && <p className="role-review-note">审阅记录：{p.reviewNote}</p>}
      </article>;
    })}</div> : <div className="daily-small-empty"><Users size={25}/><p>{showHistory ? "还没有职位提案。" : "目前没有待审或私下职位。"}<br/>给她们一些相处时间。并非每次交流都会产生职位，也没有预设领袖。</p></div>}
  </section>;
}

export function DailyLife({ state, busy, progress, pausing, onRun, onPause, onAgent, onReview }: {
  state: AppState; busy: boolean; progress: { done: number; total: number } | null; pausing: boolean;
  onRun: (steps: number, topic: string) => void; onPause: () => void; onAgent: (agent: Agent) => void;
  onReview: (id: string, decision: "approve" | "private" | "reject") => Promise<unknown>;
}) {
  const [topic, setTopic] = useState("");
  const [steps, setSteps] = useState(3);
  const [showAll, setShowAll] = useState(false);
  const members = state.agents.filter(a => a.hired && !a.archivedAt);
  const allEvents = [...(state.dailyEvents || [])].reverse();
  const events = showAll ? allEvents : allEvents.slice(0, 30);
  const departures = [...(state.membershipEvents || [])].reverse().slice(0, 6);
  return <div className="fade-in">
    <div className="page-header"><div><div className="eyebrow">✦ EVERYDAY CONNECTIONS</div><h1>闲时，也有她们的故事。</h1><p>一次问候、一点分歧，也可能是某个人主动担起责任。关系从平常的相处中生长。</p></div><div className="daily-total"><strong>{state.dailyTurn || allEvents.length}</strong><span>次日常交流</span></div></div>
    <div className="daily-layout"><div className="daily-main">
      <section className="panel daily-controls"><h2 className="panel-title"><Coffee size={16}/>给相处留一点时间</h2>
        <label className="field-label" htmlFor="daily-topic">此刻的话题 <span>可选 · {topic.length} / 1000</span></label>
        <textarea id="daily-topic" value={topic} onChange={e => setTopic(e.target.value)} maxLength={1000} rows={3} placeholder="不填则自由交流。例如：聊聊各自的日常习惯，或商量庭院里的事情该怎样分工。" disabled={!!progress}/>
        <div className="daily-run-controls"><button className="button secondary" disabled={busy || members.length < 2 || !state.config.textReady} onClick={() => onRun(1, topic.trim())}><MessageCircle size={14}/>交流一步</button><label htmlFor="daily-steps">连续交流</label><select id="daily-steps" value={steps} disabled={!!progress} onChange={e => setSteps(Number(e.target.value))}>{[3, 6, 12].map(n => <option value={n} key={n}>{n} 步</option>)}</select>{progress ? <button className="button primary" disabled={pausing} onClick={onPause}><Pause size={13}/>{pausing ? "本步结束后暂停" : "暂停交流"}</button> : <button className="button primary" disabled={busy || members.length < 2 || !state.config.textReady} onClick={() => onRun(steps, topic.trim())}><Play size={13}/>开始相处</button>}</div>
        <p className="form-hint">每一步邀请一位成员发言，并检查是否符合人设；会使用文本 API。连续交流到所选步数自动停止，离开此页面或切到后台会在当前一步结束后暂停。</p>
        {members.length < 2 && <p className="daily-requirement">至少需要两位在场成员，才能彼此交流。</p>}
        {progress && <div className="daily-progress" role="status"><LoaderCircle size={14} className="spin"/><span>已完成 {progress.done} / {progress.total} 步 · {pausing ? "正在等待当前交流结束…" : "正在发生新的交流…"}</span></div>}
      </section>
      <section className="panel daily-timeline"><div className="daily-section-heading"><h2 className="panel-title"><MessageCircle size={15}/>庭院里的近况</h2><span className="section-caption">{members.length} 位在场</span></div>
        {events.length ? <div className="daily-event-list">{events.map(e => {
          const actor = state.agents.find(a => a.id === e.agentId), target = state.agents.find(a => a.id === e.targetId);
          const present = actor?.hired && !actor.archivedAt;
          return <article className={`daily-event ${e.kind}`} key={e.id}>
            <div className="daily-event-heading"><button disabled={!present} onClick={() => actor && onAgent(actor)} className="daily-person"><span className="daily-avatar" style={{ borderColor: actor?.color }}>{actor?.name.slice(0, 1) || "·"}</span><strong>{actor?.name || "已删除成员"}</strong>{actor?.archivedAt && <small>已离开</small>}</button><time dateTime={e.createdAt}>{stamp(e.createdAt)}</time></div>
            <div className="daily-event-kind">{DAILY_LABELS[e.kind]}{e.targetId && <span> → {target?.name || "已离开的成员"}{target?.archivedAt ? "（已离开）" : ""}</span>}</div><div className="daily-event-text"><RichText>{e.content}</RichText></div>{e.checked && <div className="daily-checked"><Check size={11}/>已核对人设与能力</div>}
          </article>;
        })}</div> : <div className="daily-empty"><Coffee size={34}/><h3>还没有日常故事</h3><p>让她们聊一步，看看谁会主动靠近谁。交流、意见和关系会真实留存在这里。</p></div>}
        {allEvents.length > 30 && <button className="button ghost full" onClick={() => setShowAll(!showAll)}>{showAll ? "只看最近 30 条" : `查看全部 ${allEvents.length} 条交流`}</button>}
      </section>
    </div><aside className="daily-side"><RoleProposals state={state} busy={busy} onReview={onReview}/>
      <section className="panel daily-membership"><h2 className="panel-title"><Users size={15}/>来去都有回声</h2><p className="panel-note">离开的成员不再参与交流。留下的人会知道她暂时不在，恢复后仍带着原来的记忆回来。</p>{departures.length ? departures.map(e => <div className="membership-row" key={e.id}><span className={`status-dot ${e.kind === "left" ? "off" : ""}`}/><div><p>{e.name}{e.kind === "left" ? "离开了庭院" : "回到了庭院"}</p><time dateTime={e.createdAt}>{stamp(e.createdAt)}</time></div></div>) : <p className="membership-empty">当前还没有成员离开或返回。</p>}</section>
    </aside></div>
  </div>;
}
