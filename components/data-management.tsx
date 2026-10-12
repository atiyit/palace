"use client";

import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, CircleAlert, DoorOpen, LoaderCircle, Trash2, X } from "lucide-react";
import type { Agent, ApiResponse, AppState } from "@/lib/types";

type ConfirmAction = { kind: "leave" | "delete"; agent: Agent } | { kind: "clear" };

export function DataConfirmation({ action, busy, onCancel, onConfirm }: {
  action: ConfirmAction; busy: boolean; onCancel: () => void; onConfirm: () => Promise<unknown>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const modal = useRef<HTMLDivElement>(null);
  const expected = action.kind === "clear" ? "清除所有数据" : action.kind === "delete" ? "永久删除" : "";
  const title = action.kind === "clear" ? "清除所有庭院数据" : action.kind === "delete" ? `永久删除${action.agent.name}` : `让${action.agent.name}暂时离开`;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    modal.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !modal.current) return;
      const elements = Array.from(modal.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'));
      if (!elements.length) { event.preventDefault(); return; }
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = oldOverflow; window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  return <div className="data-modal-scrim" onKeyDown={e => { if (e.key === "Escape" && !busy) onCancel(); }}><div className="data-modal" ref={modal} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="data-confirm-title"><div className="data-modal-heading"><span className={`data-modal-icon ${expected ? "danger" : ""}`}>{action.kind === "leave" ? <DoorOpen size={22}/> : <CircleAlert size={22}/>}</span><button className="icon-button" aria-label="取消此操作" disabled={busy} onClick={onCancel}><X size={18}/></button></div><h2 id="data-confirm-title">{title}</h2>
    {action.kind === "leave" ? <p>她会进入回收站，停止推荐、私聊与新的协作。档案、聊天和记忆都会保留，随时可以恢复。其他成员会知道她暂时不在。</p> : action.kind === "delete" ? <p>这会永久删除她的档案、私聊、独立记忆和相关个人图片，并清理与她相关的记录。此操作无法撤销。</p> : <p>这会清空所有角色（包括回收站）、聊天、记忆、事务与交付文件、图片、日常交流、关系和职位，以及已保存的 API 配置、密钥和调试设置。将得到一个空白庭院，此操作无法撤销。</p>}
    <form onSubmit={async e => { e.preventDefault(); if (!busy && confirmation === expected) await onConfirm(); }}>
      {expected && <><label className="field-label" htmlFor="data-confirm-input">输入「{expected}」确认</label><input id="data-confirm-input" autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} placeholder={expected}/></>}
      <div className="data-modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button><button className={`button ${expected ? "danger" : "primary"}`} type="submit" disabled={busy || confirmation !== expected}>{busy ? <LoaderCircle size={14} className="spin"/> : action.kind === "leave" ? <DoorOpen size={14}/> : <Trash2 size={14}/>} {action.kind === "leave" ? "移入回收站" : expected}</button></div>
    </form></div></div>;
}

export function DataManagement({ state, busy, onAction }: {
  state: AppState; busy: boolean; onAction: (action: string, payload: Record<string, unknown>, success?: string) => Promise<ApiResponse | null>;
}) {
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const archived = state.agents.filter(a => !!a.archivedAt);
  const perform = async () => {
    if (!confirm) return;
    const result = confirm.kind === "clear" ? await onAction("data.clear", { confirmation: "清除所有数据" }, "所有庭院数据已清除。请重新配置模型，开始新的故事。") : confirm.kind === "delete" ? await onAction("member.delete", { agentId: confirm.agent.id, confirmation: "永久删除" }, "已永久删除该成员及相关个人记录。") : null;
    if (result) setConfirm(null);
  };
  return <section className="data-management" aria-label="庭院数据管理"><div className="panel recycle-panel"><div className="daily-section-heading"><h2 className="panel-title"><ArchiveRestore size={16}/>暂别的成员 · 回收站</h2><span className="tag">{archived.length} 位</span></div><p className="panel-note">暂别的成员保留档案与记忆。恢复后重新加入庭院；永久删除需要再次确认。</p>
    {archived.length ? <div className="recycle-list">{archived.map(a => <article className="recycle-row" key={a.id}><div className="recycle-identity"><div className="daily-avatar">{a.name.slice(0, 1)}</div><div><h3>{a.name}</h3><p>{a.title}</p><small>{new Date(a.archivedAt!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 离开</small></div></div><div className="recycle-actions"><button className="button secondary small" disabled={busy} onClick={() => void onAction("member.restore", { agentId: a.id }, `${a.name}带着原有记忆回到了庭院。`)}><ArchiveRestore size={13}/>恢复成员</button><button className="button ghost small danger-text" disabled={busy} onClick={() => setConfirm({ kind: "delete", agent: a })}><Trash2 size={12}/>永久删除</button></div></article>)}</div> : <div className="recycle-empty"><ArchiveRestore size={22}/><span>回收站是空的。在成员档案中选择「离开庭院」，她会出现在这里。</span></div>}
  </div><div className="panel data-danger-zone"><div><h2 className="panel-title"><Trash2 size={15}/>清除所有数据</h2><p className="panel-note">删除整个庭院存档、图片、交付文件和已保存的 API 配置。操作前需要输入确认词。</p></div><button className="button secondary danger-text" disabled={busy} onClick={() => setConfirm({ kind: "clear" })}>清除所有数据</button></div>{confirm && <DataConfirmation action={confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={perform}/>}</section>;
}
