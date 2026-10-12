"use client";

import { useEffect, useState } from "react";
import { BadgeCheck, Check, Feather, Trash2 } from "lucide-react";
import type { Agent } from "@/lib/types";

export function AppointmentEditor({ agent, busy, onSave, onRemove }: {
  agent: Agent;
  busy: boolean;
  onSave: (title: string, duties: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}) {
  const [title, setTitle] = useState(agent.appointment?.title || "");
  const [duties, setDuties] = useState(agent.appointment?.duties || "");
  useEffect(() => { setTitle(agent.appointment?.title || ""); setDuties(agent.appointment?.duties || ""); }, [agent.id, agent.appointment]);
  if (!agent.hired) return <div className="memory-empty">加入庭院后，才可以为她任命职位。</div>;
  return <div className="appointment-editor">
    <div className="appointment-intro"><BadgeCheck size={22}/><div><h3>由你任命，各司其职</h3><p>为{agent.name}安排一个职位与职责。她会以此参与相处与协作，同时保留独立人格与能力边界。</p></div></div>
    {agent.appointment && <div className="appointment-current"><span>当前用户任命</span><strong>{agent.appointment.title}</strong><small>{new Date(agent.appointment.appointedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} 任命</small></div>}
    <form onSubmit={event => { event.preventDefault(); if (!busy && title.trim()) void onSave(title.trim(), duties.trim()); }}>
      <label className="field-label" htmlFor="appointment-title">职位名称 <span>{title.length} / 30</span></label>
      <input id="appointment-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={30} required placeholder="例如：庭院总管、首席谋士" disabled={busy}/>
      <div className="appointment-suggestions">{["庭院总管", "策划顾问", "审校负责人"].map(value => <button type="button" disabled={busy} key={value} onClick={() => setTitle(value)}>{value}</button>)}</div>
      <label className="field-label" htmlFor="appointment-duties">职责说明 <span>{duties.length} / 600</span></label>
      <textarea id="appointment-duties" value={duties} onChange={event => setDuties(event.target.value)} maxLength={600} rows={6} placeholder="例如：主动协调任务分工，整理各方意见；保留不同观点，并向我说明仍有分歧的地方。" disabled={busy}/>
      <div className="appointment-editor-actions"><button type="submit" className="button primary" disabled={busy || !title.trim()}><Check size={13}/>{agent.appointment ? "保存职位调整" : "确认任命"}</button>{agent.appointment && <button type="button" className="button secondary" disabled={busy} onClick={() => void onRemove()}><Trash2 size={13}/>撤销任命</button>}</div>
    </form>
    <div className="observation-note"><Feather size={13}/><span>这里是你的明确任命，会作为职责信息提供给她。它不会增加曝光权重、凭空提升能力，或制造新的协作关系；其他成员仍可以独立决定是否接受邀请。</span></div>
  </div>;
}

export function AppointmentBadge({ agent }: { agent: Agent }) {
  if (!agent.appointment) return null;
  return <span className="appointment-badge" title={`用户任命：${agent.appointment.title}${agent.appointment.duties ? `。${agent.appointment.duties}` : ""}`}><BadgeCheck size={11}/><span>用户任命 · {agent.appointment.title}</span></span>;
}

export function AppointmentsSummary({ members }: { members: Agent[] }) {
  const appointed = members.filter(a => a.appointment);
  return <div className="panel appointments-summary"><h2 className="panel-title"><BadgeCheck size={15}/>用户任命</h2><p className="panel-note">职位来自你的安排，与图中自发形成的协作关系分别记录。</p>{appointed.length ? appointed.map(a => <div className="appointment-summary-row" key={a.id}><div><strong>{a.name}</strong><span>{a.appointment!.title}</span></div>{a.appointment!.duties && <p>{a.appointment!.duties}</p>}</div>) : <p className="appointment-none">还没有任命。打开成员档案的「职位」，可安排她的职责。</p>}</div>;
}
