"use client";

import { useState } from "react";
import { Check, CircleAlert, Code2, Download, FileText, Globe, LoaderCircle, PackageOpen, Sparkles } from "lucide-react";
import type { AppState, Task } from "@/lib/types";
import { RichText } from "@/components/rich-text";

const TOOL_NAMES = { "web.search": "网络搜索", "web.read": "读取网页", "code.run": "代码运行 · JavaScript", "file.write": "写入文件", "image.generate": "生成图片" };
const TOOL_ICONS = { "web.search": Globe, "web.read": Globe, "code.run": Code2, "file.write": FileText, "image.generate": Sparkles };
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function TaskDeliverables({ task, state, busy, delivering, onDeliver }: {
  task: Task; state: AppState; busy: boolean; delivering: boolean; onDeliver: (message: string) => void;
}) {
  const [brief, setBrief] = useState("");
  const artifacts = task.artifacts || [];
  const runs = task.toolRuns || [];
  const activeParticipants = task.participants.some(id => state.agents.some(a => a.id === id && a.hired && !a.archivedAt));
  return <section className="task-deliverables" aria-label="事务交付物与工具记录">
    <div className="daily-section-heading"><h2 className="panel-title"><PackageOpen size={16}/>把想法变成成果</h2><span className="tag">{artifacts.length} 份文件</span></div><p className="panel-note">让参与成员根据共议内容制作可下载文件。她们可按需要搜索网页、运行 JavaScript 或写入文件，工具的实际结果会完整记录。</p>
    <label className="field-label" htmlFor={`deliver-brief-${task.id}`}>补充交付要求 <span>可选</span></label><textarea id={`deliver-brief-${task.id}`} value={brief} onChange={e => setBrief(e.target.value)} maxLength={4000} rows={2} placeholder="例如：给我一份可下载的活动方案，以及 CSV 预算表；列出查证来源。" disabled={delivering}/>
    <div className="deliver-actions"><button className="button primary" disabled={busy || !state.config.textReady || !activeParticipants} onClick={() => onDeliver(brief.trim())}>{delivering ? <LoaderCircle size={14} className="spin"/> : <Sparkles size={14}/>} {delivering ? "正在制作交付物…" : artifacts.length ? "继续生成交付物" : "生成交付物"}</button><span>每次最多调用 6 次工具 · 可继续生成</span></div>
    {!activeParticipants && <p className="daily-requirement">当前没有在场的事务参与者。恢复一位成员后，即可继续制作。</p>}
    {artifacts.length ? <div className="task-artifact-grid">{artifacts.map(file => {
      const author = state.agents.find(a => a.id === file.agentId);
      const usable = file.url.startsWith("/api/") && !file.url.startsWith("//");
      return <article className="task-artifact" key={file.id}><span className="task-file-icon"><FileText size={23}/></span><div><h3>{file.name}</h3><p>{author?.name || "已离开成员"} · {fileSize(file.size)}</p><small>{new Date(file.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></div>{usable ? <a className="icon-button" href={file.url} download={file.name} aria-label={`下载${file.name}`} title={`下载 ${file.name}`}><Download size={17}/></a> : <span className="tag">文件不可用</span>}</article>;
    })}</div> : <div className="deliver-empty"><FileText size={21}/><p>还没有交付文件。共议结束后，或已有清晰方向时，点击「生成交付物」。</p></div>}
    <details className="task-tool-log" open={delivering || undefined}><summary><Code2 size={14}/>实际工具记录 <span>{runs.length} 次</span></summary>{runs.length ? <div className="tool-run-list">{runs.map(run => {
      const Icon = TOOL_ICONS[run.tool];
      return <details className={`tool-run ${run.status}`} key={run.id}><summary><Icon size={14}/><strong>{TOOL_NAMES[run.tool]}</strong><span className="tool-run-agent">{state.agents.find(a => a.id === run.agentId)?.name || "成员"}</span><span className="tool-run-status">{run.status === "ok" ? <Check size={12}/> : <CircleAlert size={12}/>} {run.status === "ok" ? "成功" : "未完成"}</span></summary><p className="tool-input-summary">{run.inputSummary}</p>{run.error && <p className="tool-run-error">{run.error}</p>}{run.output && <div className="tool-output"><RichText>{run.output}</RichText></div>}</details>;
    })}</div> : <p className="panel-note">尚未调用工具。这里会显示真实成功或失败的执行结果。</p>}</details>
  </section>;
}
