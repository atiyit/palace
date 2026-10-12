"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, AtSign, BookOpen, Check, ChevronDown, CircleHelp, Code2, Download, ExternalLink, FileText, Globe, Heart, ImagePlus, LoaderCircle, MessageCircle, PackageOpen, Pause, Play, Reply, Send, Sparkles, Square, Users } from "lucide-react";
import type { Agent, AppState as PublicState, SocialEvent, Task, TaskArtifact, ToolRun } from "@/lib/types";
import { RichText } from "@/components/rich-text";

export interface TaskGroupProps {
  task?: Task;
  state: PublicState;
  busy: boolean;
  running: boolean;
  pausing: boolean;
  onPause: () => void;
  onRun: () => void;
  onFinish: () => void;
  onAgent: (agent: Agent) => void;
  onAdopt: (eventId: string) => void;
  onSend: (message: string, rounds: number) => Promise<boolean>;
  onContinue: (rounds: number) => Promise<void>;
}

const EVENT_LABELS: Record<SocialEvent["kind"], string> = { propose: "提出建议", request: "邀请协作", accept: "接受协作", refuse: "婉拒邀请", challenge: "提出质疑", help: "提供帮助", submit: "分享成果" };
const TOOL_LABELS: Record<ToolRun["tool"], string> = { "web.search": "搜索网页", "web.read": "读取网页", "code.run": "运行代码", "file.write": "写入文件", "image.generate": "生成图片" };
const TOOL_ICONS = { "web.search": Globe, "web.read": Globe, "code.run": Code2, "file.write": FileText, "image.generate": ImagePlus };
const timestamp = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fileSize = (value: number) => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
const actorType = (event: SocialEvent) => event.actorType || "agent";
const artifactRoute = (artifact: TaskArtifact) => /^[a-zA-Z0-9_-]{1,100}$/.test(artifact.id) ? `/api/artifacts/${artifact.id}` : null;

function GroupAvatar({ agent, kind = "agent" }: { agent?: Agent; kind?: "agent" | "user" | "system" }) {
  const [failed, setFailed] = useState(false);
  const portrait = agent?.portrait && /^\/(?:portraits\/[a-zA-Z0-9_/-]+\.(?:png|webp|jpe?g|svg)|api\/portraits\/[a-zA-Z0-9_-]{1,100})(?:\?v=[a-zA-Z0-9_.%-]+)?$/.test(agent.portrait) ? agent.portrait : null;
  useEffect(() => setFailed(false), [portrait]);
  return <span className={`tg-avatar ${kind}`}>{portrait && !failed && kind === "agent" ? <img src={portrait} alt="" loading="lazy" onError={() => setFailed(true)}/> : kind === "system" ? <Sparkles size={15}/> : kind === "user" ? "你" : agent?.name.slice(0, 1) || "她"}</span>;
}

function GroupArtifact({ artifact, artifacts, agents, onAgent }: { artifact: TaskArtifact; artifacts: TaskArtifact[]; agents: Agent[]; onAgent: (agent: Agent) => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const route = artifactRoute(artifact);
  const mime = artifact.mimeType.split(";")[0].toLowerCase();
  const isImage = artifact.kind === "image" || mime.startsWith("image/");
  const preview = !!route && ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(mime);
  const contributors = [...new Set(artifact.contributorIds?.length ? artifact.contributorIds : [artifact.agentId])];
  const sources = (artifact.derivedFromIds || []).map(id => artifacts.find(item => item.id === id)?.name || "此前共享成果");
  useEffect(() => { setImageFailed(false); setReload(0); }, [artifact.id]);
  return <article className={`tg-artifact ${isImage ? "image" : "file"}`}>
    {preview && (imageFailed ? <div className="tg-image-error"><ImagePlus size={20}/><p>预览暂时无法加载，仍可下载文件。</p><button type="button" onClick={() => { setImageFailed(false); setReload(value => value + 1); }}>重新加载预览</button></div> : <a className="tg-artifact-preview" href={`${route}?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`查看图片 ${artifact.name}`}><img src={`${route}?inline=1${reload ? `&reload=${reload}` : ""}`} alt={artifact.name} loading="lazy" onError={() => setImageFailed(true)}/></a>)}
    <div className="tg-artifact-main"><span className="tg-file-icon">{isImage ? <ImagePlus size={20}/> : <FileText size={20}/>}</span><div><h4>{artifact.name}</h4><p>{isImage ? "共享图片" : "可下载文件"} · {fileSize(artifact.size)}</p></div>{route ? <a className="icon-button" href={route} download={artifact.name} aria-label={`下载 ${artifact.name}`} title="下载文件"><Download size={16}/></a> : <span className="tg-file-unavailable">文件不可用</span>}</div>
    <div className="tg-artifact-credit"><span>贡献成员</span>{contributors.map(id => {
      const person = agents.find(agent => agent.id === id);
      return person ? <button type="button" key={id} onClick={() => onAgent(person)}>{person.name}</button> : <span key={id}>已离开成员</span>;
    })}{preview && route && <a href={`${route}?inline=1`} target="_blank" rel="noopener noreferrer">原图<ExternalLink size={10}/></a>}</div>
    {sources.length > 0 && <details className="tg-derived"><summary>沿用了 {sources.length} 份已有成果</summary><p>{sources.join("、")}</p></details>}
  </article>;
}

function GroupTools({ runs, agents }: { runs: ToolRun[]; agents: Agent[] }) {
  return <details className="tg-resources tg-tools"><summary><Code2 size={15}/><strong>实际工具记录</strong><span>{runs.length} 次</span><ChevronDown size={14}/></summary><div className="tg-resources-body">{runs.length ? runs.map(run => {
    const Icon = TOOL_ICONS[run.tool] || Code2;
    return <details className={`tg-tool-run ${run.status}`} key={run.id}><summary><Icon size={14}/><strong>{TOOL_LABELS[run.tool] || run.tool}</strong><span>{agents.find(agent => agent.id === run.agentId)?.name || "成员"}</span><span className="tg-tool-status">{run.status === "ok" ? <Check size={12}/> : <CircleHelp size={12}/>} {run.status === "ok" ? "已完成" : "未完成"}</span></summary><time>{timestamp(run.createdAt)}</time><p className="tg-tool-label">请求内容</p><pre>{run.inputSummary}</pre>{run.error && <p className="tg-tool-error">{run.error}</p>}{run.output && <><p className="tg-tool-label">实际返回</p><div className="tg-tool-output"><RichText>{run.output}</RichText></div></>}</details>;
  }) : <p className="tg-resources-empty">尚未调用工具。成员可以先讨论，确有需要时再搜索、计算、写文件或生成图片。</p>}</div></details>;
}

export function TaskGroup({ task, state, busy, running, pausing, onPause, onRun, onFinish, onAgent, onAdopt, onSend, onContinue }: TaskGroupProps) {
  const [message, setMessage] = useState("");
  const [rounds, setRounds] = useState(1);
  const [localOperation, setLocalOperation] = useState<"send" | "continue" | null>(null);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState(false);
  const operationRef = useRef(false);
  const stream = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const previousTask = useRef<string | undefined>(undefined);
  const currentTask = useRef(task?.id);
  currentTask.current = task?.id;
  const events = useMemo(() => state.events.filter(event => event.taskId === task?.id), [state.events, task?.id]);
  const artifacts = task?.artifacts || [];
  const runs = task?.toolRuns || [];
  const participants = task?.participants.map(id => state.agents.find(agent => agent.id === id)).filter((agent): agent is Agent => !!agent) || [];
  const active = participants.some(agent => agent.hired && !agent.archivedAt);
  const locked = busy || running || pausing || !!localOperation;
  const canSend = !!task && active && state.config.textReady && !locked && Number.isSafeInteger(rounds) && rounds >= 0;

  useEffect(() => { setMessage(""); setRounds(1); setError(""); setUnread(false); nearBottom.current = true; }, [task?.id]);
  useEffect(() => {
    const changed = previousTask.current !== task?.id;
    previousTask.current = task?.id;
    if (changed || nearBottom.current) {
      const frame = requestAnimationFrame(() => {
        if (stream.current) stream.current.scrollTop = stream.current.scrollHeight;
        setUnread(false);
      });
      return () => cancelAnimationFrame(frame);
    }
    setUnread(true);
  }, [task?.id, events.length, events.at(-1)?.id, artifacts.length, runs.length, running]);

  const scrollLatest = () => { nearBottom.current = true; stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: "smooth" }); setUnread(false); };
  const jumpTo = (eventId: string) => {
    const container = stream.current, node = document.getElementById(`tg-event-${task?.id}-${eventId}`);
    if (!container || !node) return;
    nearBottom.current = false;
    container.scrollTo({ top: Math.max(0, node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16), behavior: "smooth" });
  };
  const mention = (agent: Agent) => { setMessage(value => `${value}${value && !/\s$/.test(value) ? " " : ""}@${agent.name} `); input.current?.focus(); };
  const send = async () => {
    if (!canSend || !message.trim() || operationRef.current) return;
    const sent = message.trim(), taskId = task?.id;
    operationRef.current = true; setLocalOperation("send"); setError("");
    nearBottom.current = true;
    try {
      const sentSuccessfully = await onSend(sent, rounds);
      if (currentTask.current === taskId) {
        if (sentSuccessfully) { setMessage(value => value.trim() === sent ? "" : value); if (nearBottom.current) scrollLatest(); else setUnread(true); }
        else setError("消息尚未发送成功，请查看提示后重试。");
      }
    } catch (failure) { if (currentTask.current === taskId) setError(failure instanceof Error ? failure.message : "消息尚未发送成功，请重试。"); }
    finally { operationRef.current = false; setLocalOperation(null); }
  };
  const continueGroup = async () => {
    if (!canSend || operationRef.current) return;
    const taskId = task?.id;
    operationRef.current = true; setLocalOperation("continue"); setError("");
    try { await onContinue(rounds); }
    catch (failure) { if (currentTask.current === taskId) setError(failure instanceof Error ? failure.message : "暂时无法继续共议，请重试。"); }
    finally { operationRef.current = false; setLocalOperation(null); }
  };

  if (!task) return <section className="tg-empty panel"><MessageCircle size={34}/><h2>把一件事，放进群聊。</h2><p>创建共议后，你与参与成员可以在这里连续交流。想法、彼此回应、图片和实际文件会留在同一段对话中。</p><span>先创建一个事务，邀请她们一起开始。</span></section>;

  return <section className="task-group" aria-label="事务群聊">
    <div className="tg-conversation panel"><header className="tg-heading"><div><span className="eyebrow">A SHARED CONVERSATION</span><h2>{task.title}</h2><p><span className={`status-dot ${running ? "" : "off"}`}/>{running ? pausing ? "正在完成当前操作" : "正在共议" : task.status === "completed" ? "本次已结束，可以继续交流" : task.status === "paused" ? "共议已暂停" : "等待继续本轮"}<span>{task.rounds === 0 ? `· 第 ${task.round} 轮 · 持续共议` : `· 第 ${Math.min(task.round, task.rounds)} / ${task.rounds} 轮`}</span></p></div><div className="tg-heading-actions">{running ? <button type="button" className="button secondary small" disabled={pausing} onClick={onPause}><Pause size={12}/>{pausing ? "正在等候暂停" : "暂停"}</button> : task.status !== "completed" ? <button type="button" className="button secondary small" disabled={locked || !state.config.textReady || !active} onClick={onRun}><Play size={12}/>继续本轮</button> : <span className="tg-finished"><Check size={13}/>本次完成</span>}{task.status !== 'completed' && <button type="button" className="button ghost small" disabled={pausing || !!localOperation || (!running && busy)} onClick={onFinish}><Square size={12}/>结束共议</button>}</div></header>
      <div className="tg-participants"><span><Users size={13}/>{task.participants.length} 位参与者</span><div>{participants.map(agent => <button type="button" className={agent.archivedAt || !agent.hired ? "away" : ""} key={agent.id} onClick={() => onAgent(agent)}><GroupAvatar agent={agent}/>{agent.name}{(agent.archivedAt || !agent.hired) && <small>已离开</small>}</button>)}</div></div>
      <div className="tg-memory-note"><BookOpen size={13}/><p>{events.length ? "群聊记录已保存，成员会结合本群上下文与各自记忆继续。" : "成员会结合本群的公开交流与各自记忆参与。"} 私聊与私人记忆不会在群里公开。</p></div>
      {task.lastError && <div className="tg-error" role="alert"><CircleHelp size={14}/><span>{task.lastError}</span></div>}
      <div className="tg-stream" ref={stream} tabIndex={0} aria-label="群聊发言记录" onScroll={() => { const node = stream.current; if (!node) return; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 65; if (nearBottom.current) setUnread(false); }}>
        {events.length ? events.map(event => {
          const kind = actorType(event), author = state.agents.find(agent => agent.id === event.agentId), target = state.agents.find(agent => agent.id === event.targetId);
          const replied = event.replyTo ? events.find(previous => previous.id === event.replyTo) : undefined;
          const replyName = replied ? actorType(replied) === "user" ? "你" : actorType(replied) === "system" ? "庭院记录" : state.agents.find(agent => agent.id === replied.agentId)?.name || "成员" : "";
          const attachments = artifacts.filter(artifact => artifact.eventId === event.id || event.artifactIds?.includes(artifact.id));
          return <article className={`tg-message ${kind} ${event.checked ? "checked" : "unchecked"}`} key={event.id} id={`tg-event-${task.id}-${event.id}`}>
            {kind === "agent" && author ? <button type="button" className="tg-message-avatar" aria-label={`查看${author.name}的档案`} onClick={() => onAgent(author)}><GroupAvatar agent={author}/></button> : <GroupAvatar kind={kind}/>}
            <div className="tg-message-main"><div className="tg-message-meta"><strong>{kind === "user" ? "你" : kind === "system" ? "庭院记录" : author?.name || "已离开成员"}</strong>{kind === "agent" && <span>{EVENT_LABELS[event.kind]}</span>}<time>{timestamp(event.createdAt)}</time><span className="tg-round">第 {event.round} 轮</span></div>
              <div className="tg-message-bubble">{replied && <button type="button" className="tg-reply-quote" onClick={() => jumpTo(replied.id)}><Reply size={12}/><span><strong>回复 {replyName}</strong><span>{replied.content.slice(0, 140)}</span></span></button>}{event.targetId && <div className="tg-target">{target ? <button type="button" onClick={() => onAgent(target)}>@{target.name}</button> : <span>@已离开成员</span>}</div>}<RichText>{event.content}</RichText>{attachments.length > 0 && <div className="tg-message-attachments">{attachments.map(artifact => <GroupArtifact key={artifact.id} artifact={artifact} artifacts={artifacts} agents={state.agents} onAgent={onAgent}/>)}</div>}</div>
              {kind === "agent" && event.checked && <div className="tg-message-actions"><button type="button" disabled={locked || !!event.adoptedAt || !author?.hired || !!author.archivedAt} onClick={() => onAdopt(event.id)}>{event.adoptedAt ? <Check size={12}/> : <Heart size={12}/>} {event.adoptedAt ? "已采纳" : "采纳这条贡献"}</button>{author && <button type="button" disabled={locked} onClick={() => mention(author)}><AtSign size={12}/>回应她</button>}</div>}
            </div>
          </article>;
        }) : <div className="tg-first-message"><MessageCircle size={27}/><h3>给讨论留一个开始。</h3><p>继续本轮，或在下方补充想法。她们可以先用文字回应，需要时再带来文件与图片。</p></div>}
        {running && <div className="tg-running" role="status"><LoaderCircle size={14} className="spin"/><span>{pausing ? "正在保存当前操作，随后暂停或结束。" : "成员正在结合讨论作出回应；需要使用工具时，耗时可能更久。"}</span></div>}
      </div>
      {unread && <button type="button" className="tg-new-messages" onClick={scrollLatest}><ArrowDown size={13}/>查看最新发言</button>}
      <form className="tg-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <div className="tg-composer-top"><label htmlFor={`tg-input-${task.id}`}>加入这场对话</label><details className="tg-mention-picker"><summary><AtSign size={12}/>提及成员</summary><div>{participants.map(agent => <button type="button" key={agent.id} disabled={locked} onClick={() => mention(agent)}>@{agent.name}</button>)}</div></details></div>
        <textarea ref={input} id={`tg-input-${task.id}`} value={message} maxLength={4000} rows={3} disabled={locked} placeholder="补充需求、回应她们，或 @一位成员继续讨论。例如：先比较两个方向，再一起把预算表补完整。" onChange={event => { setMessage(event.target.value); setError(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
        {error && <p className="tg-composer-error" role="alert">{error}</p>}
        <div className="tg-composer-bottom"><div className="tg-round-picker"><label htmlFor={`tg-rounds-${task.id}`}>{task.status === "completed" ? "接着聊几轮" : "下次续聊轮数"}</label><input id={`tg-rounds-${task.id}`} className="unlimited-number" type="number" min={0} step={1} inputMode="numeric" value={rounds} disabled={locked} onChange={event => setRounds(Number(event.target.value))}/><span>0 = 不限</span></div><div className="tg-send-actions">{task.status === "completed" && <button type="button" className="button secondary" disabled={!canSend} onClick={() => void continueGroup()}>{localOperation === "continue" ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>}继续共议</button>}<button type="submit" className="button primary" disabled={!canSend || !message.trim()}>{localOperation === "send" ? <LoaderCircle size={13} className="spin"/> : <Send size={13}/>}发送到群聊</button></div></div>
        <p className="tg-composer-hint">{!active ? "当前没有在场的参与成员，请恢复成员或新建事务。" : !state.config.textReady ? "请先在庭院设置连接文本模型。" : running ? "本次共议在后台继续，暂停或结束后可以发言。" : "Enter 发送，Shift + Enter 换行。0 轮会持续交流，可通过结束共议保留成果并停止。"}</p>
      </form>
    </div>
    <details className="tg-resources tg-shared"><summary><PackageOpen size={15}/><strong>全部共享成果</strong><span>{artifacts.length} 份</span><ChevronDown size={14}/></summary><div className="tg-resources-body"><p className="tg-resources-explainer">本事务保存的全部文件与图片，包括早期尚未关联到某条发言的成果。</p>{artifacts.length ? <div className="tg-shared-grid">{artifacts.map(artifact => <GroupArtifact key={artifact.id} artifact={artifact} artifacts={artifacts} agents={state.agents} onAgent={onAgent}/>)}</div> : <p className="tg-resources-empty">还没有共享文件或图片。纯文字讨论同样会保留在群聊中。</p>}</div></details>
    <GroupTools runs={runs} agents={state.agents}/>
  </section>;
}
