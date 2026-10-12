"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Coffee, Compass, DoorOpen, Feather, Heart, ImagePlus, Layers, LoaderCircle, LockKeyhole, FlaskConical, Menu, MessageCircle, Network, Pause, Play, Plus, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Square, Trash2, Users, WandSparkles, X } from "lucide-react";
import type { Agent, AppState, ApiResponse, Memory, UserImage } from "@/lib/types";
import { SKILL_LABELS } from "@/lib/types";
import { recommendationProbabilities, weightedSample } from "@/lib/domain";
import { RichText } from "@/components/rich-text";
import { ProviderSettings } from "@/components/provider-settings";
import { DebugWorkbench } from "@/components/debug-workbench";
import { AppointmentBadge, AppointmentEditor } from "@/components/appointment-editor";
import { CharacterProfile, SpeciesBadge, ageLabel } from "@/components/character-profile";
import { AUTH_ERROR, IS_LOCAL_APP } from "@/components/runtime-mode";
import { RecruitmentPanel } from "@/components/recruitment-panel";
import { ChatImageAttachment, ChatImageExamples } from "@/components/chat-image";
import { DAILY_LABELS, DailyLife, PrivateRoleBadges } from "@/components/daily-life";
import { DataConfirmation, DataManagement } from "@/components/data-management";
import { RelationshipOverview } from "@/components/relations";
import { TaskGroup } from "@/components/task-group";
import { UserProfileEditor } from "@/components/user-profile-editor";
import { ChatUploadControls, UserChatImage } from "@/components/user-chat-images";
import { userAvatarUrl } from '@/lib/user-profile';
import { RuntimeLimits } from '@/components/runtime-limits';
import type { ActivityStatus } from '@/lib/server/activity-runner';

type View = "discover" | "recruit" | "members" | "daily" | "tasks" | "relations" | "settings" | "debug";
type DrawerTab = "chat" | "persona" | "memory" | "appointment";
type Voice = { agent: Agent; id: string; content: string; createdAt: string; source: string; private: boolean };
function latestVoices(state: AppState): Voice[] {
  return state.agents.filter(a => a.hired && !a.archivedAt).flatMap<Voice>(agent => {
    const chat = [...agent.chats].reverse().find(message => message.role === "assistant" && message.checked === true);
    const event = [...state.events].reverse().find(event => event.agentId === agent.id && event.checked === true);
    const daily = [...(state.dailyEvents || [])].reverse().find(event => event.agentId === agent.id && event.checked === true);
    if (!chat && !event && !daily) return [];
    if (daily && (!chat || Date.parse(daily.createdAt) > Date.parse(chat.createdAt)) && (!event || Date.parse(daily.createdAt) > Date.parse(event.createdAt))) return [{ agent, id: daily.id, content: daily.content, createdAt: daily.createdAt, source: `日常 · ${DAILY_LABELS[daily.kind]}`, private: false }];
    if (chat && (!event || Date.parse(chat.createdAt) >= Date.parse(event.createdAt))) {
      return [{ agent, id: chat.id, content: chat.content, createdAt: chat.createdAt, source: "你们的私聊", private: true }];
    }
    return event ? [{ agent, id: event.id, content: event.content, createdAt: event.createdAt, source: `共议 · 第 ${event.round} 轮 · ${EVENT_LABELS[event.kind]}`, private: false }] : [];
  });
}
const NAV = [
  { id: "discover" as View, label: "为你推荐", icon: Compass },
  { id: "recruit" as View, label: "寻访招募", icon: Sparkles },
  { id: "members" as View, label: "我的后宫", icon: Users },
  { id: "daily" as View, label: "日常相处", icon: Coffee },
  { id: "tasks" as View, label: "共议事务", icon: Layers },
  { id: "relations" as View, label: "关系观察", icon: Network },
  { id: "debug" as View, label: "框架调试", icon: FlaskConical },
  { id: "settings" as View, label: "庭院设置", icon: Settings2 },
];
const EVENT_LABELS = { propose: "提出建议", request: "发出邀约", accept: "接受协作", refuse: "婉拒邀请", challenge: "提出质疑", help: "提供帮助", submit: "提交成果" };
const MEMORY_LABELS = { preference: "你的偏好", experience: "共同经历", relationship: "关系记忆", strategy: "策略反思" };
const STATUS_LABELS = { running: "正在共议", paused: "已暂停", completed: "已完成" };
const FILTERS = ["全部相遇", "善于谋划", "灵感与创意", "落地执行", "我已偏爱"];
const PORTRAIT_STYLES = ["jade", "pearl", "amber", "plum", "mist", "rose", "indigo", "fern"];
const UNKNOWN_PORTRAIT = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024"><defs><radialGradient id="g"><stop stop-color="#403449"/><stop offset="1" stop-color="#1c202a"/></radialGradient></defs><rect width="768" height="1024" fill="url(#g)"/><g stroke="#a58cb3" fill="none" opacity=".36"><circle cx="384" cy="430" r="210"/><circle cx="384" cy="430" r="152" stroke-dasharray="3 15"/><path d="M384 173V687M127 430H641M205 251L563 609M205 609L563 251" stroke-dasharray="2 14"/><path d="M384 300L476 430L384 560L292 430Z" stroke="#d1b38a" stroke-width="2"/></g><g fill="#cab49a"><circle cx="384" cy="430" r="9"/><circle cx="384" cy="220" r="4"/><circle cx="594" cy="430" r="4"/><circle cx="384" cy="640" r="4"/><circle cx="174" cy="430" r="4"/></g></svg>')}`;
const portraitOf = (a: Agent) => a.portrait || (a.species?.kind && a.species.kind !== "human" ? UNKNOWN_PORTRAIT : `/portraits/${PORTRAIT_STYLES[Array.from(a.id).reduce((n,c)=>n+c.charCodeAt(0),0)%8]}.svg`);
const timeOf = (s: string) => new Date(s).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" });
const dayOf = (s: string) => new Date(s).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "short", day: "numeric" });

export default function Home() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [view, setView] = useState<View>("discover");
  const [menuOpen, setMenuOpen] = useState(false);
  const [debugOpened, setDebugOpened] = useState(false);
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [dataEpoch, setDataEpoch] = useState(0);
  const [leavingAgent, setLeavingAgent] = useState<Agent | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("chat");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean; retry?: () => void } | null>(null);
  const [filter, setFilter] = useState("全部相遇");
  const [sampleIds, setSampleIds] = useState<string[]>([]);
  const [voiceIds, setVoiceIds] = useState<string[]>([]);
  const [brief, setBrief] = useState("");
  const [recruitCount, setRecruitCount] = useState(3);
  const [recruitActiveSlots, setRecruitActiveSlots] = useState<number[]>([]);
  const [chat, setChat] = useState("");
  const [selectedChatImage, setSelectedChatImage] = useState<{ agentId: string; imageId: string } | null>(null);
  const [removingUpload, setRemovingUpload] = useState<string | undefined>();
  const [chattingAgent, setChattingAgent] = useState<string | null>(null);
  const [retryingImage, setRetryingImage] = useState<{ agentId: string; messageId: string } | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [rounds, setRounds] = useState(2);
  const [participantCount, setParticipantCount] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityStatus | null>(null);
  const [activityChecking, setActivityChecking] = useState(true);
  const [activityError, setActivityError] = useState('');
  const [activityControl, setActivityControl] = useState<'pause' | 'stop' | null>(null);
  const [exploration, setExploration] = useState(.2);
  const [drama, setDrama] = useState(.5);
  const busyRef = useRef(false);
  const chatDraftVersion = useRef(0);
  const activityRef = useRef<ActivityStatus | null>(null);
  const activityCheckingRef = useRef(true);
  const activityControlRef = useRef(false);
  const mutationVersion = useRef(0);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const stateRef = useRef<AppState | null>(null);
  const activityActive = activity?.status === 'running' || activity?.status === 'pausing';
  const activityTask = activity?.kind === 'task' ? state?.tasks.find(task => task.id === activity.taskId) : undefined;
  const activityStatus = activity?.kind === 'task' && !activityActive && activityTask?.status === 'completed' && !activityTask.lastError ? 'completed' : activity?.status;
  const runningTask = activityActive && activity?.kind === 'task' ? activity.taskId : null;
  const pausingTask = !!runningTask && (activity?.status === 'pausing' || !!activityControl);
  const dailyProgress = activityActive && activity?.kind === 'daily' ? { done: activity.done, total: activity.steps } : null;
  const pausingDaily = !!dailyProgress && (activity?.status === 'pausing' || !!activityControl);
  const backgroundLocked = () => activityCheckingRef.current || ['running', 'pausing'].includes(activityRef.current?.status || '');
  const updateActivity = useCallback((next: ActivityStatus | null) => { activityRef.current = next; setActivity(next); }, []);

  const sampleVoices = useCallback((next: AppState) => {
    setVoiceIds(weightedSample(latestVoices(next).map(voice => voice.agent), 4, next.settings.exploration).map(a => a.id));
  }, []);
  const updateState = useCallback((next: AppState) => {
    const previousIds = stateRef.current ? latestVoices(stateRef.current).map(v => v.agent.id).sort().join("|") : null;
    const nextIds = latestVoices(next).map(v => v.agent.id).sort().join("|");
    if (previousIds !== nextIds) sampleVoices(next);
    stateRef.current = next; setState(next);
  }, [sampleVoices]);
  const load = useCallback(async () => {
    setLoadError(""); setAuthRequired(false);
    try {
      const response = await fetch("/api/palace", { cache: "no-store" });
      if (response.status === 401) { setAuthRequired(true); return; }
      const data = await response.json() as AppState & { state?: AppState; error?: string };
      if (!response.ok) throw new Error(data.error || "庭院暂时无法连接");
      const next: AppState = data.state || data;
      updateState(next); setExploration(next.settings.exploration); setDrama(next.settings.drama);
      setSampleIds(weightedSample(next.agents.filter(a => !a.archivedAt), 8, next.settings.exploration).map(a => a.id));
    } catch (e) { setLoadError(e instanceof Error ? e.message : "连接失败，请稍后重试"); }
  }, [updateState]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selectedAgent && !state?.agents.some(a => a.id === selectedAgent && !a.archivedAt)) setSelectedAgent(null); }, [state?.agents, selectedAgent]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastRevision = '';
    // 主人切页或暂时离开时，后端照常值守；我只同步进度，不再让浏览器决定何时停工。
    const poll = async () => {
      const observedVersion = mutationVersion.current;
      try {
        const response = await fetch('/api/activity', { cache: 'no-store' });
        if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
        const data = await response.json() as { activity: ActivityStatus | null; error?: string };
        if (!response.ok) throw new Error(data.error || '无法读取后台交流状态。');
        if (cancelled) return;
        const next = data.activity;
        const revision = next ? `${next.id}:${next.status}:${next.done}:${next.updatedAt}` : 'idle';
        if (revision !== lastRevision && !busyRef.current) {
          const version = mutationVersion.current;
          const saved = await fetch('/api/palace', { cache: 'no-store' });
          const snapshot = await saved.json() as AppState & { state?: AppState; error?: string };
          if (!saved.ok) throw new Error(snapshot.error || '无法同步已保存的交流。');
          if (cancelled) return;
          if (version === mutationVersion.current && !busyRef.current) { updateState(snapshot.state || snapshot); lastRevision = revision; }
        }
        if (cancelled || observedVersion !== mutationVersion.current) return;
        updateActivity(next); setActivityError('');
        activityCheckingRef.current = false; setActivityChecking(false);
      } catch (error) {
        if (!cancelled) {
          activityCheckingRef.current = true; setActivityChecking(true);
          setActivityError(error instanceof Error ? error.message : '后台状态暂时无法同步，请保持本机服务运行。');
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [updateActivity, updateState]);
  useEffect(() => { if (!toast || toast.error) return; const timer = window.setTimeout(() => setToast(null), 4000); return () => window.clearTimeout(timer); }, [toast]);
  const latestChat = state?.agents.find(item => item.id === selectedAgent)?.chats.at(-1);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [latestChat?.id, latestChat?.image?.status, latestChat?.image?.url, selectedAgent, drawerTab]);
  useEffect(() => {
    if (!selectedAgent) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    drawerRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedAgent(null);
      if (event.key !== "Tab" || !drawerRef.current) return;
      const items = Array.from(drawerRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],textarea:not(:disabled),input:not(:disabled),[tabindex="0"]'));
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = oldOverflow; window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [selectedAgent]);

  const request = useCallback(async (action: string, payload: Record<string, unknown> = {}, id?: string): Promise<ApiResponse> => {
    mutationVersion.current += 1;
    const response = await fetch("/api/palace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload, requestId: id || crypto.randomUUID() }) });
    if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
    const data: ApiResponse = await response.json();
    mutationVersion.current += 1;
    if (data.state) {
      updateState(data.state);
      if (["like", "chat", "hire", "adopt", "settings"].includes(action)) sampleVoices(data.state);
      if (action === "data.clear") {
        setSelectedAgent(null); setLeavingAgent(null); setDebugOpened(false); setDataEpoch(epoch => epoch + 1);
        setSampleIds([]); setVoiceIds([]); setTaskId(null); setTaskTitle(""); setBrief(""); setChat(""); setChattingAgent(null); setRetryingImage(null);
        setSelectedChatImage(null); setRemovingUpload(undefined);
        chatDraftVersion.current += 1;
        setRecruitActiveSlots([]); setRecruitCount(3); setRounds(2); setParticipantCount(0); setFilter("全部相遇");
        updateActivity(null);
        setExploration(data.state.settings.exploration); setDrama(data.state.settings.drama);
      }
    }
    if (!response.ok || data.error) throw new Error(data.error || "操作未完成，请重试");
    return data;
  }, [updateState, sampleVoices, updateActivity]);

  const act = useCallback(async (action: string, payload: Record<string, unknown> = {}, success?: string): Promise<ApiResponse | null> => {
    if (busyRef.current || activityCheckingRef.current || ['running', 'pausing'].includes(activityRef.current?.status || '')) return null;
    if (stateRef.current?.pendingCleanup?.length && action !== "cleanup.retry") { setToast({ text: "请先完成剩余数据清理，再执行其他操作。", error: true }); return null; }
    const id = crypto.randomUUID();
    const run = async (): Promise<ApiResponse | null> => {
      if (busyRef.current || activityCheckingRef.current || ['running', 'pausing'].includes(activityRef.current?.status || '')) return null;
      busyRef.current = true; setBusy(action); setToast(null);
      try { const data = await request(action, payload, id); const pending = !!data.state.pendingCleanup?.length; if (success || data.message || pending) setToast({ text: data.message || (pending ? "记录已更新，存储清理尚未完成，请重试数据清理。" : success) || "已保存", error: pending }); return data; }
      catch (e) { setToast({ text: e instanceof Error ? e.message : "操作失败", error: true, retry: ["recruit", "recruit.retry", "chat", "chat.image.retry", "member.trash", "member.delete", "data.clear", "task.deliver"].includes(action) ? undefined : () => { void run(); } }); return null; }
      finally { busyRef.current = false; setBusy(null); }
    };
    return run();
  }, [request]);

  const startActivity = async (input: { kind: 'task' | 'daily'; taskId?: string; topic?: string; steps: number }) => {
    if (busyRef.current || backgroundLocked() || stateRef.current?.pendingCleanup?.length) return;
    if (!Number.isSafeInteger(input.steps) || input.steps < 0) return;
    busyRef.current = true; mutationVersion.current += 1; setBusy('activity.start'); setToast(null);
    try {
      const response = await fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', ...input }) });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const data = await response.json() as { activity?: ActivityStatus; error?: string };
      if (!response.ok || !data.activity) throw new Error(data.error || '后台交流未能启动。');
      mutationVersion.current += 1; updateActivity(data.activity);
      setActivityError('');
    } catch (error) { setToast({ text: error instanceof Error ? error.message : '后台交流未能启动。', error: true }); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const controlActivity = async (action: 'pause' | 'stop') => {
    const current = activityRef.current;
    if (!current || activityControlRef.current || !['running', 'pausing'].includes(current.status)) return;
    activityControlRef.current = true; mutationVersion.current += 1; setActivityControl(action);
    try {
      const response = await fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id: current.id }) });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const data = await response.json() as { activity?: ActivityStatus; error?: string };
      if (!response.ok || !data.activity) throw new Error(data.error || '尚未收到后台交流的控制结果。');
      mutationVersion.current += 1; updateActivity(data.activity);
    } catch (error) { setToast({ text: error instanceof Error ? error.message : '操作未完成，请重试。', error: true }); }
    finally { activityControlRef.current = false; setActivityControl(null); }
  };
  const runTask = (id: string) => startActivity({ kind: 'task', taskId: id, steps: 0 });
  const runDaily = (steps: number, topic: string) => startActivity({ kind: 'daily', steps, topic });
  const sendGroupMessage = async (id: string, message: string, rounds: number): Promise<boolean> => {
    const result = await act('task.message', { taskId: id, message, rounds });
    if (!result) return false;
    void runTask(id); return true;
  };
  const continueGroup = async (id: string, rounds: number): Promise<void> => {
    const result = await act('task.continue', { taskId: id, rounds });
    if (result) void runTask(id);
  };
  const cleanupPending = !!state?.pendingCleanup?.length;
  const interactionBusy = !!busy || cleanupPending || activityActive || activityChecking;
  const members = state?.agents.filter(a => a.hired && !a.archivedAt) || [];
  const candidates = state?.agents.filter(a => !a.hired && !a.archivedAt) || [];
  const agent = state?.agents.find(a => a.id === selectedAgent && !a.archivedAt);
  const chatImage = selectedChatImage?.agentId === agent?.id ? state?.userUploads?.find(image => image.id === selectedChatImage?.imageId) : undefined;
  const selectedTask = state?.tasks.find(t => t.id === taskId) || state?.tasks[0];
  const probabilities = useMemo(() => state ? recommendationProbabilities(state.agents.filter(a => !a.archivedAt), state.settings.exploration) : {}, [state]);
  const voices = useMemo(() => {
    if (!state) return [];
    const byAgent = new Map(latestVoices(state).map(voice => [voice.agent.id, voice]));
    return voiceIds.map(id => byAgent.get(id)).filter((voice): voice is Voice => !!voice);
  }, [state, voiceIds]);
  const recommended = useMemo(() => {
    if (!state) return [];
    const byId = new Map(state.agents.filter(a => !a.archivedAt).map(a => [a.id, a]));
    const ordered = sampleIds.map(id => byId.get(id)).filter((a): a is Agent => !!a);
    return ordered.length ? ordered : state.agents.filter(a => !a.archivedAt).slice(0, 8);
  }, [state, sampleIds]);
  const filtered = (view === "members" ? members : view === "recruit" ? candidates : recommended).filter(a => filter === "善于谋划" ? a.skills.planning >= 75 : filter === "灵感与创意" ? a.skills.creativity >= 75 : filter === "落地执行" ? a.skills.execution >= 75 : filter === "我已偏爱" ? a.liked : true);
  const navigate = (next: View) => { if (next === "debug") setDebugOpened(true); if (next === "settings") setSettingsOpened(true); setView(next); setFilter("全部相遇"); setMenuOpen(false); };
  const changeChat = (value: string) => { chatDraftVersion.current += 1; setChat(value); };
  const openAgent = (a: Agent, tab: DrawerTab = a.hired ? "chat" : "persona") => { setSelectedAgent(a.id); setDrawerTab(tab); changeChat(""); setSelectedChatImage(null); };
  const shuffle = () => { if (state) { setSampleIds(weightedSample(state.agents.filter(a => !a.archivedAt), 8, state.settings.exploration).map(a => a.id)); sampleVoices(state); setToast({ text: "已按你的偏好重新推荐发言与相遇。" }); } };
  const sendChat = async () => {
    if (!agent || (!chat.trim() && !chatImage) || busyRef.current || backgroundLocked() || !state?.config.textReady) return;
    const message = chat.trim();
    const draftVersion = chatDraftVersion.current;
    const imageId = chatImage?.id;
    setChattingAgent(agent.id);
    try {
      const result = await act("chat", { agentId: agent.id, message, ...(imageId ? { imageId } : {}) });
      if (result) {
        if (chatDraftVersion.current === draftVersion) setChat(current => current.trim() === message ? "" : current);
        if (imageId) setSelectedChatImage(current => current?.imageId === imageId ? null : current);
      }
    }
    finally { setChattingAgent(null); }
  };
  const uploadChatImage = async (file: File, requestId: string): Promise<boolean> => {
    if (!agent || busyRef.current || backgroundLocked() || stateRef.current?.pendingCleanup?.length) return false;
    const agentId = agent.id;
    busyRef.current = true; mutationVersion.current += 1; setBusy("chat.upload"); setToast(null);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("无法读取这张图片，请重新选择。"));
        reader.onabort = () => reject(new Error("图片读取已中止，请重新选择。"));
        reader.onload = () => typeof reader.result === "string" && reader.result.includes(",") ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("图片读取格式无效。"));
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/chat-uploads", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataBase64, contentType: file.type, name: file.name.slice(0, 160), requestId }) });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const result = await response.json() as { state?: AppState; image?: UserImage; error?: string; message?: string };
      if (!response.ok || result.error) throw new Error(result.error || "图片上传未完成，请重试。");
      if (!result.state || !result.image) throw new Error("未收到完整上传结果，请重新上传确认。");
      mutationVersion.current += 1;
      updateState(result.state);
      setSelectedChatImage({ agentId, imageId: result.image.id });
      return true;
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : "图片上传失败，尚未发送消息。", error: true }); return false;
    } finally { busyRef.current = false; setBusy(null); }
  };
  const removeChatUpload = async (imageId: string): Promise<void> => {
    if (busyRef.current || backgroundLocked() || stateRef.current?.pendingCleanup?.length) return;
    busyRef.current = true; mutationVersion.current += 1; setBusy("chat.upload.remove"); setRemovingUpload(imageId); setToast(null);
    try {
      const response = await fetch("/api/chat-uploads", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", imageId, requestId: crypto.randomUUID() }) });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const result = await response.json() as { state?: AppState; error?: string; message?: string };
      if (!response.ok || result.error) throw new Error(result.error || "待发图片尚未移除。");
      if (!result.state) throw new Error("未收到移除后的记录，请重新连接确认。");
      mutationVersion.current += 1;
      updateState(result.state);
      setSelectedChatImage(current => current?.imageId === imageId ? null : current);
      setToast({ text: result.message || "待发送图片已移除。", error: !!result.state.pendingCleanup?.length });
    } catch (error) { setToast({ text: error instanceof Error ? error.message : "待发图片移除失败。", error: true }); }
    finally { busyRef.current = false; setBusy(null); setRemovingUpload(undefined); }
  };
  const retryChatImage = async (agentId: string, messageId: string) => {
    if (busyRef.current) return;
    setRetryingImage({ agentId, messageId });
    try {
      const result = await act("chat.image.retry", { agentId, messageId });
      const image = result?.state.agents.find(item => item.id === agentId)?.chats.find(item => item.id === messageId)?.image;
      if (image?.status === "failed") setToast({ text: image.error || "图片仍未生成成功，你可以稍后重试。", error: true });
      else if (image?.status === "ready") setToast({ text: "图片已补上，原来的文字回复保留。" });
    } finally { setRetryingImage(null); }
  };
  const createTask = async () => { if (!taskTitle.trim() || !Number.isSafeInteger(rounds) || rounds < 0 || !Number.isSafeInteger(participantCount) || participantCount < 0) return; const result = await act("task.create", { title: taskTitle.trim(), rounds, participantCount }); if (result) { const id = result.taskId || result.state.tasks.at(-1)?.id; setTaskTitle(""); setTaskId(id || null); if (id) void runTask(id); } };
  const showRecruitmentResult = (result: ApiResponse) => {
    const batch = result.state.recruitment;
    if (batch?.applied) {
      setFilter("全部相遇");
      setSampleIds(weightedSample(result.state.agents.filter(a => !a.archivedAt), 8, result.state.settings.exploration).map(a => a.id));
      setToast({ text: result.message || `${batch.slots.filter(slot => slot.status === 'succeeded').length} 份档案已加入候选池。` });
    } else if (batch) {
      const passed = batch.slots.filter(slot => slot.status === "succeeded").length;
      setToast({ text: result.message || `已保留 ${passed} / ${batch.count} 份档案。请查看未通过原因，再决定重新生成哪些。`, error: true });
    }
  };
  const recruit = async () => {
    if (!brief.trim() || busyRef.current) return;
    setRecruitActiveSlots(Array.from({ length: recruitCount }, (_, index) => index + 1));
    try { const result = await act("recruit", { brief: brief.trim(), count: recruitCount }); if (result) showRecruitmentResult(result); }
    finally { setRecruitActiveSlots([]); }
  };
  const randomRecruitment = async (recruitImmediately: boolean) => {
    if (busyRef.current || backgroundLocked() || stateRef.current?.pendingCleanup?.length || !stateRef.current?.config.textReady) return;
    busyRef.current = true; mutationVersion.current += 1; setBusy(recruitImmediately ? 'recruit.random' : 'recruit.idea'); setToast(null);
    const count = recruitCount;
    try {
      const response = await fetch('/api/recruitment-ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: brief.trim(), count }) });
      if (response.status === 401) { setAuthRequired(true); throw new Error(AUTH_ERROR); }
      const data = await response.json() as { brief?: string; message?: string; error?: string };
      if (!response.ok || !data.brief) throw new Error(data.error || '随机人物设定尚未生成，请重试。');
      setBrief(data.brief);
      if (recruitImmediately) {
        setBusy('recruit'); setRecruitActiveSlots(Array.from({ length: count }, (_, index) => index + 1));
        // 主人的新设定直接交给原有寻访管线，姓名去重、逐份校验与失败重试仍由它照顾呢。
        const result = await request('recruit', { brief: data.brief, count });
        showRecruitmentResult(result);
      } else setToast({ text: data.message || '人物设定已填入，可以编辑后开始寻访。' });
    } catch (error) { setToast({ text: error instanceof Error ? error.message : '随机生成未完成，请重试。', error: true }); }
    finally { busyRef.current = false; setBusy(null); setRecruitActiveSlots([]); }
  };
  const retryRecruitment = async (slot?: number) => {
    const batch = stateRef.current?.recruitment;
    if (!batch || batch.applied || busyRef.current) return;
    const targets = batch.slots.filter(item => ['pending', 'failed'].includes(item.status) && (slot === undefined || item.slot === slot)).map(item => item.slot);
    if (!targets.length) return;
    setRecruitActiveSlots(targets);
    try { const result = await act("recruit.retry", { batchId: batch.id, ...(slot === undefined ? {} : { slot }) }); if (result) showRecruitmentResult(result); }
    finally { setRecruitActiveSlots([]); }
  };

  return <div className="app-shell">
    {menuOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
      <button className="icon-button mobile-close" aria-label="关闭导航" onClick={() => setMenuOpen(false)}><X size={18} /></button>
      <div className="brand"><span className="brand-symbol"><img src="/brand/palace-mark-128.png" width={44} height={44} alt="" /></span><div><div className="brand-name">偏爱</div><span className="brand-en">PALACE</span></div></div>
      <div className="nav-label">你的私人庭院</div>
      <nav className="nav-list" aria-label="主导航">{NAV.map(item => <button key={item.id} onClick={() => navigate(item.id)} className={`nav-button ${view === item.id ? "active" : ""}`} aria-current={view === item.id ? "page" : undefined}><item.icon size={17} strokeWidth={1.5} /><span>{item.label}</span>{item.id === "members" && !!members.length && <span className="nav-count">{members.length.toString().padStart(2, "0")}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="status-card"><strong><span className={`status-dot ${!state?.config.textReady ? "off" : ""}`} />{state?.config.textReady ? "庭院已连接" : "等待模型连接"}</strong><p>独立人格 · 共同记忆 · 自由协作</p></div><div className="sidebar-user"><OwnerAvatar url={state?.userProfile?.avatar} name={state?.userProfile?.name}/><div className="sidebar-user-details"><div className="user-name" title={state?.userProfile?.name}>{state?.userProfile?.name || '庭院主人'}</div><div className="user-caption">每一次偏爱，都留下回响</div></div><LockKeyhole size={13} style={{ marginLeft: "auto", color: "#756b81" }} /></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="展开导航" onClick={() => setMenuOpen(true)}><Menu size={18} /></button><span>我的庭院</span><ChevronRight size={11} /><span className="current">{NAV.find(n => n.id === view)?.label}</span></div><div className="topbar-right"><span className="private-badge"><LockKeyhole size={11} />{IS_LOCAL_APP ? "本机庭院 · 127.0.0.1" : "仅你可见的私人空间"}</span><button className="icon-button" title="查看运行设置" aria-label="查看运行设置" onClick={() => navigate("settings")}><Settings2 size={16} /></button></div></header>
    <main className="main-content">
      {!state ? <div className="loading-screen">{authRequired ? <div><LockKeyhole size={30} /><h1>只属于你的庭院</h1><p>{IS_LOCAL_APP ? "请保持本机服务运行，然后重新连接庭院。" : "使用你的 ChatGPT 账户登录后继续。"}</p>{IS_LOCAL_APP ? <button className="button primary" style={{ marginTop: 20 }} onClick={() => void load()}>重新连接<RefreshCw size={14}/></button> : <a className="button primary" style={{ marginTop: 20 }} href="/signin-with-chatgpt?return_to=/" target="_top">登录并进入<ArrowRight size={14} /></a>}</div> : loadError ? <div><CircleHelp size={30} /><p>{loadError}</p><button className="button secondary" style={{ marginTop: 20 }} onClick={() => void load()}>重新连接</button></div> : <div><Feather size={32} className="spin" /><p>为你打开庭院…</p></div>}</div> : <>
      {authRequired && <div className="notice"><LockKeyhole size={15} />{IS_LOCAL_APP ? <span>本机连接需要刷新。<button className="button ghost small" onClick={() => void load()}>重新连接</button></span> : <span>登录已过期。<a href="/signin-with-chatgpt?return_to=/" target="_top">重新登录</a> 后继续你的庭院。</span>}</div>}
      {activityChecking && !activityError && <div className="activity-banner" role="status"><LoaderCircle size={15} className="spin"/><p>正在恢复后台交流状态…</p></div>}
      {activityError && <div className="activity-banner error" role="alert"><CircleHelp size={16}/><p>{activityError} 正在自动重新连接；后台交流的实际状态以本机服务为准。</p></div>}
      {activity && activityStatus && (activity.kind === 'daily' || activityTask) && <section className={`activity-banner ${activityStatus}`} aria-label="后台交流状态">
        {activityActive ? <LoaderCircle size={17} className="spin"/> : activityStatus === 'failed' ? <CircleHelp size={17}/> : <Check size={17}/>}
        <div className="activity-banner-copy"><strong>{activity.kind === 'task' ? '共议' : '日常相处'} · {({ running: '后台进行中', pausing: '正在完成当前操作', paused: '已暂停', completed: '已结束', failed: '需要继续处理' })[activityStatus]}</strong><p>{activity.kind === 'task' ? activityTask?.title : activity.topic || '自由交流'} · 已完成 {activity.done}{activity.kind === 'daily' && activity.steps > 0 ? ` / ${activity.steps}` : ''} 次发言{activity.kind === 'daily' && activity.steps === 0 ? ' · 不限步数' : ''}</p>{activity.error && activityStatus === 'failed' && <p className="activity-error">{activity.error}</p>}{activityActive && <small>保持本机服务运行即可继续。暂停或结束会先保存当前操作，其他写入将在活动停止后开放。</small>}</div>
        <div className="activity-banner-actions"><button className="button ghost small" onClick={() => { if (activity.kind === 'task') { setTaskId(activity.taskId || null); navigate('tasks'); } else navigate('daily'); }}>查看交流<ArrowRight size={12}/></button>{activityActive ? <><button className="button secondary small" disabled={!!activityControl || activity.status === 'pausing'} onClick={() => void controlActivity('pause')}><Pause size={12}/>暂停</button><button className="button ghost small" disabled={!!activityControl || activity.status === 'pausing'} onClick={() => void controlActivity('stop')}><Square size={12}/>{activity.kind === 'task' ? '结束共议' : '结束交流'}</button></> : ['paused', 'failed'].includes(activityStatus) && <button className="button secondary small" disabled={interactionBusy || !state.config.textReady || (activity.kind === 'task' && !state.tasks.some(task => task.id === activity.taskId && task.status !== 'completed'))} onClick={() => void startActivity({ kind: activity.kind, taskId: activity.taskId, topic: activity.topic, steps: activity.steps === 0 ? 0 : Math.max(1, activity.steps - activity.done) })}><Play size={12}/>继续</button>}</div>
      </section>}
      {cleanupPending && <div className="notice cleanup-notice" role="alert"><CircleHelp size={16}/><div><strong>数据清理尚未完成</strong><p>已暂停生成与配置更改。请重试剩余文件和密钥的清理。</p><button className="button secondary small" disabled={!!busy} onClick={() => void act("cleanup.retry", {}, "剩余数据已清理完成。")}>{busy === "cleanup.retry" ? <LoaderCircle size={13} className="spin"/> : <RefreshCw size={13}/>}重试数据清理</button></div></div>}
      {!state.config.textReady && view !== "settings" && <div className="notice"><CircleHelp size={15} /><span>先浏览角色、收藏与招募。模型连接配置完成后，即可对话和布置事务。 <button onClick={() => navigate("settings")}>查看连接状态</button></span></div>}
      {(view === "discover" || view === "recruit" || view === "members") && <div className="fade-in">
        <div className="page-header"><div><div className="eyebrow"><span>✦</span> {view === "discover" ? "A LITTLE SERENDIPITY" : view === "recruit" ? "FIND YOUR KINDRED MINDS" : "YOUR INNER CIRCLE"}</div><h1>{view === "discover" ? "今日，遇见谁？" : view === "recruit" ? "寻一位，懂你的人。" : "相伴，各有心意。"}</h1><p>{view === "discover" ? "从偶然相遇，到渐渐偏爱。你的选择，让这个庭院慢慢生长。" : view === "recruit" ? "告诉我们你期待怎样的陪伴与能力，让新的故事开始。" : "独立的人格，共同的经历。她们记得你，也在彼此了解。"}</p></div>{view === "discover" ? <button className="button secondary" onClick={shuffle}><RefreshCw size={13} />换一批相遇</button> : view === "members" ? <button className="button primary" onClick={() => navigate("recruit")}><Plus size={14} />寻访新人</button> : null}</div>
        {view === "discover" && <div className="hero-card"><div className="hero-motif"><Feather /></div><div className="hero-main"><div className="eyebrow" style={{ fontSize: 11 }}>A COURT OF YOUR OWN</div><h2>把一件心事，交给她们一起想。</h2><p>有人擅长谋划，有人带来灵感。合作、争鸣与默契，由她们自己发生。</p></div><div className="stats-strip"><div className="mini-stat"><strong>{members.length.toString().padStart(2,"0")}</strong><span>庭院成员</span></div><div className="mini-stat"><strong>{state.tasks.filter(t => t.status === "completed").length.toString().padStart(2,"0")}</strong><span>共同完成</span></div></div><button className="button primary hero-action" onClick={() => navigate(members.length ? "tasks" : "recruit")}>{members.length ? "发起一场共议" : "开启你的庭院"}<ArrowRight size={14} /></button></div>}
        {view === "recruit" && <RecruitmentPanel brief={brief} count={recruitCount} batch={state.recruitment} busy={interactionBusy ? busy || "activity" : null} textReady={state.config.textReady} activeSlots={recruitActiveSlots} onBriefChange={setBrief} onCountChange={setRecruitCount} onRecruit={recruit} onRandomBrief={() => randomRecruitment(false)} onRandomRecruit={() => randomRecruitment(true)} onRetry={retryRecruitment} onSkip={async slot => { const batch = state.recruitment; if (!batch) return; const result = await act("recruit.skip", { batchId: batch.id, slot }); if (result) showRecruitmentResult(result); }}/> }
        {view === "discover" && members.length > 0 && <section className="voice-section" aria-label="按你的偏好推荐的真实发言">
          <div className="section-heading"><h2>她们的声音 <small>VOICES FOR YOU</small></h2><button className="button ghost" onClick={() => { if (state) sampleVoices(state); }} disabled={!voices.length}><RefreshCw size={12} />换一批声音</button></div>
          <p className="voice-explainer">你的喜欢、聊天与采纳影响推荐。每人取一条近期真实发言，发得更多不会获得额外权重。</p>
          {voices.length ? <div className="feed-events">{voices.map(voice => <VoiceCard key={voice.id} voice={voice} busy={interactionBusy} onOpen={() => openAgent(voice.agent)} onLike={() => void act("like", { agentId: voice.agent.id }, voice.agent.liked ? "已撤回这次偏爱。" : `已记住你对${voice.agent.name}的偏爱，发言推荐已更新。`)} />)}</div> : <div className="voices-empty"><MessageCircle size={22}/><div><h3>还没有她们的声音</h3><p>先聊一段，或一起完成一件事。她们的真实回复会在这里，按你的偏好被推荐。</p><div className="voices-empty-actions"><button className="button secondary small" onClick={() => openAgent(members[0])}>与{members[0].name}聊聊<ArrowRight size={12}/></button><button className="button ghost" onClick={() => navigate("tasks")}>发起共议<ArrowRight size={12}/></button></div></div></div>}
        </section>}
        <div className="section-heading"><h2>{view === "members" ? "庭院中的她们" : view === "recruit" ? "等待与你相遇" : "可能合你心意"}<small>{view === "members" ? "COMPANIONS" : "FOR YOU"}</small></h2><span className="section-caption"><Sparkles size={11} />{view === "members" ? `${members.length} 位成员，各有自己的记忆` : `${Math.round(state.settings.exploration * 100)}% 偶然 · 其余留给你的偏爱`}</span></div>
        <div className="filter-group">{FILTERS.map(f => <button key={f} onClick={() => setFilter(f)} className={`filter-chip ${filter === f ? "active" : ""}`}>{f}</button>)}</div>
        {filtered.length ? <div className="character-grid">{filtered.map((a,i) => <CharacterCard key={a.id} agent={a} index={i} probability={probabilities[a.id] || 0} busy={interactionBusy} onOpen={() => openAgent(a)} onLike={() => void act("like", {agentId:a.id}, a.liked ? "已撤回这次偏爱。" : `你的偏爱已被记住，${a.name}的推荐权重提高了。`)} onHire={() => void act("hire", {agentId:a.id}, `${a.name}已走进你的庭院。`)} />)}</div> : <div className="empty-state"><Users size={32}/><h3>{view === "members" ? "庭院还在等第一位来客" : "这里还没有相遇"}</h3><p>{view === "members" ? "从简历中选择你喜欢的人。加入之后，就能单独对话，或邀请她参与共议。" : "试试其他筛选条件，或者描述需求，开始一次新的寻访。"}</p><button className="button primary" onClick={() => view === "members" ? navigate("recruit") : setFilter("全部相遇")}>{view === "members" ? "去寻访招募" : "查看全部"}<ArrowRight size={13}/></button></div>}
        <div className="feed-footer"><Feather size={12}/>喜欢与主动聊天，会让她更常出现。也为未曾相识的人，留一点偶然。</div>
      </div>}
      {view === "daily" && <DailyLife key={dataEpoch} state={state} busy={interactionBusy} progress={dailyProgress} pausing={pausingDaily} onRun={(steps, topic) => void runDaily(steps, topic)} onPause={() => void controlActivity("pause")} onAgent={a => openAgent(a)} onReview={(proposalId, decision) => act("role.review", { proposalId, decision })}/>}
      {view === "tasks" && <div className="fade-in"><PageHeading eyebrow="THINK TOGETHER" title="有事，一起商量。" description="在一个群里接着聊：文字、图片与文件都是回答，成果可以一起完善，经历会进入各自的记忆。"/><div className="task-layout"><div><div className="panel task-create"><h2 className="panel-title"><Feather size={15}/>发起新的共议</h2><label className="field-label" htmlFor="task-title">这次，你想做什么？</label><textarea id="task-title" value={taskTitle} onChange={e => setTaskTitle(e.target.value)} maxLength={2500} disabled={interactionBusy} placeholder="例如：一起策划咖啡馆开业。先聊方向，再合作写方案、算预算，合适的话画一张宣传图。"/><div className="task-number-fields"><label htmlFor="task-rounds"><span className="field-label">本次交流轮数</span><input id="task-rounds" className="unlimited-number" type="number" min={0} step={1} inputMode="numeric" value={rounds} disabled={interactionBusy} onChange={event=>setRounds(Number(event.target.value))}/><small>0 = 持续共议</small></label><label htmlFor="task-participants"><span className="field-label">参与人数</span><input id="task-participants" className="unlimited-number" type="number" min={0} step={1} inputMode="numeric" value={participantCount} disabled={interactionBusy} onChange={event=>setParticipantCount(Number(event.target.value))}/><small>0 = 全部在场成员</small></label></div><p className="form-hint" style={{marginBottom:17}}>从 {members.length} 位成员中{participantCount === 0 ? "邀请全体" : `随机邀请最多 ${participantCount} 位`}，每轮随机安排发言顺序。<br/>成员可以发文字、生成图片和文件，主动邀请别人协作。工具按需要调用。<br/>共议由本机服务继续；切换页面、隐藏窗口或刷新不会暂停，可随时暂停或结束。</p><button className="button primary full" disabled={interactionBusy || !taskTitle.trim() || members.length < 1 || !state.config.textReady || !Number.isSafeInteger(rounds) || rounds < 0 || !Number.isSafeInteger(participantCount) || participantCount < 0} onClick={()=>void createTask()}>{busy==="task.create"?<LoaderCircle size={14} className="spin"/>:<Plus size={14}/>}开始共议</button>{members.length<1&&<button className="button ghost full" onClick={()=>navigate("recruit")}>先邀请一位成员<ArrowRight size={12}/></button>}</div><div className="task-list">{[...state.tasks].reverse().map(t=><button key={t.id} className={`task-list-item ${selectedTask?.id===t.id?"active":""}`} onClick={()=>setTaskId(t.id)}><strong>{t.title}</strong><span className="task-meta"><span>{t.status === 'completed' ? '等待续聊' : STATUS_LABELS[t.status]}</span><span>·</span><span>{dayOf(t.createdAt)}</span></span></button>)}</div></div><TaskGroup task={selectedTask} state={state} running={runningTask===selectedTask?.id} pausing={runningTask===selectedTask?.id && pausingTask} busy={interactionBusy} onPause={()=>void controlActivity("pause")} onRun={()=>{if(selectedTask)void runTask(selectedTask.id);}} onFinish={()=>{if(!selectedTask)return;if(runningTask===selectedTask.id)void controlActivity("stop");else void act("task.finish",{taskId:selectedTask.id},"共议已结束，成果与交流记录已保留。");}} onAgent={a=>openAgent(a)} onAdopt={eventId=>void act("adopt",{eventId},"已采纳这条贡献，她会记住你的认可。")} onSend={(message,rounds)=>selectedTask ? sendGroupMessage(selectedTask.id,message,rounds) : Promise.resolve(false)} onContinue={rounds=>selectedTask ? continueGroup(selectedTask.id,rounds) : Promise.resolve()}/></div></div>}
      {view === "relations" && <div className="fade-in"><PageHeading eyebrow="EMERGENCE, NOT ASSIGNMENT" title="关系，在相处中生长。" description="从闲谈、支持与分歧，到协作和私下共识。观察关系怎样形成，再决定哪些职位正式生效。"/>{members.length ? <RelationshipOverview state={state} portraitOf={portraitOf} onAgent={a=>openAgent(a,"memory")}/> : <div className="empty-state"><Network size={34}/><h3>关系从相遇开始</h3><p>招募成员后发起日常交流或共议，这里会记录她们的实际互动。</p><button className="button primary" onClick={()=>navigate("recruit")}>去遇见她们<ArrowRight size={13}/></button></div>}</div>}
      {settingsOpened && <div hidden={view !== "settings"}><div className="fade-in"><PageHeading eyebrow="MAKE IT YOURS" title="庭院，随你心意。" description="调整偶然与偏爱的比例，让关系以你喜欢的节奏发展。"/><div className="settings-layout"><div className="panel"><h2 className="panel-title"><Settings2 size={15}/>推荐与相处</h2><div className="setting-row"><div><h3>保留多少偶然？</h3><p>随机探索比例越高，较少出现的人越有机会被你看见。初始权重相同，推荐自然随机。</p></div><div><div className="range-value">{Math.round(exploration*100)}% 随机探索</div><input aria-label="随机探索比例" type="range" min="0.05" max="0.5" step="0.05" value={exploration} onChange={e=>setExploration(Number(e.target.value))}/><div className="range-labels"><span>熟悉的偏爱</span><span>更多新相遇</span></div></div></div><div className="setting-row"><div><h3>争取偏爱的主动程度</h3><p>影响表达、邀约与展示成果的积极性。不会改写核心人格、价值观或能力边界。</p></div><div><div className="range-value">{drama<.35?"含蓄克制":drama<.7?"各展心意":"积极争取"} · {Math.round(drama*100)}%</div><input aria-label="争宠主动程度" type="range" min="0" max="1" step="0.1" value={drama} onChange={e=>setDrama(Number(e.target.value))}/><div className="range-labels"><span>从容相伴</span><span>热闹争鸣</span></div></div></div><div className="save-row"><button className="button primary" disabled={interactionBusy} onClick={()=>void act("settings",{exploration,drama},"庭院偏好已保存。")}>{busy==="settings"?<LoaderCircle size={13} className="spin"/>:<Check size={13}/>}保存偏好</button></div></div><RuntimeLimits key={"limits-" + dataEpoch} settings={state.settings} busy={interactionBusy} onSave={async values => !!await act("settings",values,"记忆与共议额度已保存。")}/><UserProfileEditor key={"profile-" + dataEpoch} state={state} busy={interactionBusy} onState={updateState} onBusyChange={value=>{busyRef.current=value;setBusy(value?"user.profile":null);}}/><ProviderSettings key={"provider-" + dataEpoch} busy={interactionBusy} onSaved={load} onBusyChange={value=>{busyRef.current=value;setBusy(value?"provider.settings":null);}}/><div className="panel"><h2 className="panel-title"><ShieldCheck size={15}/>你的私人空间</h2><dl className="config-list"><dt>访问范围</dt><dd>{IS_LOCAL_APP ? "本机应用 · 仅 127.0.0.1" : "私人应用 · 通过 ChatGPT 身份验证"}</dd><dt>记忆存储</dt><dd>{IS_LOCAL_APP ? "本机 SQLite 持久化，每位成员独立保存" : "服务端持久化，每位成员独立保存"}</dd></dl><p className="panel-note" style={{marginTop:20}}>{IS_LOCAL_APP ? "API 密钥与庭院数据保存在本机。文本与生图请求会发送到你配置的 API 服务，角色肖像、对话与记忆不会发送给其他用户。" : "API 密钥仅保存在服务端。角色肖像、对话与长期记忆不会发送给其他用户。"}</p></div><div className="panel"><h2 className="panel-title"><BookOpen size={15}/>记得你，也保持自己</h2><p className="panel-note">短期记忆保留近期对话与本次事务；长期记忆提炼你的偏好、共同经历、关系与策略反思。她们可以调整争取你欣赏的方式，但核心人设与能力边界始终不变。你可以在每位成员的「记忆与策略」中查看、修改或删除长期记忆。</p></div><DataManagement key={"data-" + dataEpoch} state={state} busy={!!busy || activityActive || activityChecking} onAction={act}/></div></div></div>}
      {debugOpened && <div hidden={view !== "debug"}><DebugWorkbench key={dataEpoch} state={state} busy={interactionBusy} onBusyChange={value=>{busyRef.current=value;setBusy(value?"debug":null);}}/></div>}
      </>}
    </main></div>
    {agent && <><button className="drawer-backdrop" aria-label="关闭角色详情" onClick={()=>setSelectedAgent(null)}/><aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={`${agent.name}的档案`} tabIndex={-1}><div className="drawer-top"><span>PERSONAL ARCHIVE / 独属于她的故事</span><button className="icon-button" aria-label="关闭角色详情" onClick={()=>setSelectedAgent(null)}><X size={18}/></button></div><div className="drawer-profile"><img className="drawer-avatar" src={portraitOf(agent)} alt={agent.portrait?`${agent.name}的肖像`:`${agent.name}尚未生成肖像`}/><div><h2>{agent.name}</h2><p>{agent.title}</p><div className="drawer-species-line"><SpeciesBadge agent={agent}/><span>{ageLabel(agent)}</span></div><AppointmentBadge agent={agent}/>{state && <PrivateRoleBadges agent={agent} state={state}/>}<div className="character-tags">{agent.traits.slice(0,3).map(t=><span className="tag" key={t}>{t}</span>)}</div></div><div className="drawer-profile-actions"><button className="button secondary small" disabled={interactionBusy} onClick={()=>void act("like",{agentId:agent.id})}><Heart size={12} fill={agent.liked?"currentColor":"none"}/>{agent.liked?"已偏爱":"喜欢她"}</button>{!agent.hired&&<button className="button primary small" disabled={interactionBusy} onClick={()=>void act("hire",{agentId:agent.id},`${agent.name}已加入庭院。`)}>邀入庭院</button>}{agent.hired&&<button className="button ghost small" disabled={interactionBusy} onClick={()=>{setSelectedAgent(null);setLeavingAgent(agent);}}><DoorOpen size={12}/>离开庭院</button>}</div></div><div className="drawer-tabs" role="tablist" aria-label="角色档案分类">{[{id:"chat" as const,label:"与她私聊"},{id:"persona" as const,label:"人物档案"},{id:"memory" as const,label:"记忆与策略"},...(agent.hired?[{id:"appointment" as const,label:"职位"}]:[])].map(t=><button key={t.id} role="tab" aria-selected={drawerTab===t.id} onClick={()=>setDrawerTab(t.id)} className={drawerTab===t.id?"active":""}>{t.label}</button>)}</div><div className="drawer-content">
      {drawerTab==="chat" && <>{!agent.hired?<div className="empty-state"><MessageCircle size={28}/><h3>先让故事有个开始</h3><p>邀请{agent.name}加入庭院后，就可以单独聊天，共同留下记忆。</p><button className="button primary" disabled={interactionBusy} onClick={()=>void act("hire",{agentId:agent.id},`${agent.name}已加入庭院。`)}>邀请她加入<Plus size={13}/></button></div>:<><div className="chat-hint">只属于你与{agent.name}的对话 · 她会记得重要的事</div>{!agent.chats.length&&<div className="chat-message"><div className="chat-author">初见 · 人物试答</div><div className="chat-bubble"><RichText>{agent.tagline}</RichText></div></div>}{agent.chats.map(m=><div key={m.id} className={`chat-message ${m.role}`}><div className="chat-author">{m.role==="user"?"你":agent.name} · {timeOf(m.createdAt)}</div><div className="chat-bubble"><RichText>{m.content}</RichText>{m.attachments?.map(image=><UserChatImage key={image.id} image={image}/>)}{m.role==="assistant"&&m.image&&<ChatImageAttachment image={m.image} agentName={agent.name} busy={interactionBusy} imageReady={!!state?.config.imageReady} retrying={busy==="chat.image.retry"&&retryingImage?.agentId===agent.id&&retryingImage?.messageId===m.id} onRetry={()=>retryChatImage(agent.id,m.id)}/>}</div></div>)}{busy==="chat"&&chattingAgent===agent.id&&<div className="loading-inline chat-response-pending" role="status"><LoaderCircle className="spin" size={14}/><span>{state?.config.imageReady?"正在回复，图片请求可能需要更久…":`${agent.name}正在斟酌措辞…`}</span></div>}<div ref={chatEnd}/></>}</>}
      {drawerTab==="persona"&&<CharacterProfile key={agent.id} agent={agent} busy={interactionBusy} enriching={busy==="profile.enrich"} generating={busy==="portrait"} textReady={!!state?.config.textReady} imageReady={!!state?.config.imageReady} onEnrich={()=>act("profile.enrich",{agentId:agent.id},`${agent.name}的详细档案已补充，原有身份与能力保持不变。`)} onPortrait={()=>act("portrait",{agentId:agent.id},"她的新肖像已保存。")} onCopy={text=>{void navigator.clipboard.writeText(text).then(()=>setToast({text:"提示词已复制。"})).catch(()=>setToast({text:"复制失败，可手动选择文字复制。",error:true}));}}/>}
      {drawerTab==="memory"&&<><div className="detail-section strategy-card"><h3><Sparkles size={13}/>她此刻的相处策略</h3><p>{agent.strategy}</p></div><div className="detail-section"><h3><BookOpen size={13}/>长期记忆 <span className="muted">{agent.memories.length} 条</span></h3><p style={{fontSize:11,marginBottom:13,color:"#86768f"}}>个人长期记忆{(state?.settings.memoryLimit ?? 0) === 0 ? "不限条数" : `达到 ${state?.settings.memoryLimit} 条后停止新增，已有记忆不自动裁切`}；另为每场共议保留一条持续更新的经历摘要，可修正或遗忘。删除记忆不会删除原对话。策略随经历调整，但不能覆盖核心人设。</p>{agent.memories.length?agent.memories.map(m=><MemoryCard key={m.id} memory={m} busy={interactionBusy} onDelete={()=>void act("memory.delete",{agentId:agent.id,memoryId:m.id},"这条记忆已被删除。")} onSave={content=>act("memory.update",{agentId:agent.id,memoryId:m.id,content},"长期记忆已更新。")}/>):<div className="memory-empty">尚未形成长期记忆。对话与共同事务会留下第一段经历。</div>}</div><div className="detail-section"><h3><MessageCircle size={13}/>短期记忆 · 近期对话</h3><p style={{fontSize:11,marginBottom:12,color:"#9f87ae"}}>保留最近 40 条对话，每次调用读取最近 12 条；下方展示最近 8 条。</p>{agent.chats.length?agent.chats.slice(-8).map(m=><div className="memory-item" key={m.id}><p>{m.content}</p><div className="memory-meta"><span>{m.role==="user"?"你":agent.name} · {dayOf(m.createdAt)} {timeOf(m.createdAt)}</span></div></div>):<div className="memory-empty">还没有近期对话。</div>}</div><div className="detail-section"><h3><Users size={13}/>短期记忆 · 近期共议</h3>{state?.events.filter(e=>e.agentId===agent.id||e.targetId===agent.id||state.tasks.some(t=>t.mode==="group"&&t.id===e.taskId&&t.participants.includes(agent.id))).slice(-5).map(e=><div className="memory-item" key={e.id}><p>{e.content}</p><div className="memory-meta"><span>{e.actorType==="user"?"你":e.actorType==="system"?"系统记录":EVENT_LABELS[e.kind]} · 第 {e.round} 轮{e.artifactIds?.length ? ` · ${e.artifactIds.length} 项成果` : ""}</span></div></div>)}{!state?.events.some(e=>e.agentId===agent.id||e.targetId===agent.id||state.tasks.some(t=>t.mode==="group"&&t.id===e.taskId&&t.participants.includes(agent.id)))&&<div className="memory-empty">参与事务后，相关交流会出现在这里。</div>}</div><div className="detail-section"><h3><Coffee size={13}/>短期记忆 · 日常相处</h3>{state?.dailyEvents?.filter(e=>e.agentId===agent.id||e.targetId===agent.id).slice(-8).map(e=><div className="memory-item" key={e.id}><p>{e.content}</p><div className="memory-meta"><span>{DAILY_LABELS[e.kind]} · {dayOf(e.createdAt)}</span></div></div>)}{!state?.dailyEvents?.some(e=>e.agentId===agent.id||e.targetId===agent.id)&&<div className="memory-empty">日常相处中的交流会保留在这里。</div>}</div></>}
      {drawerTab==="appointment"&&<AppointmentEditor key={agent.id} agent={agent} busy={interactionBusy} onSave={(title,duties)=>act("appointment.set",{agentId:agent.id,title,duties},`${agent.name}的职位已保存。`)} onRemove={()=>act("appointment.remove",{agentId:agent.id},"已撤销这项用户任命。")}/>}
    </div>{drawerTab==="chat"&&agent.hired&&<div className="chat-composer">{state?.config.imageReady&&!chatImage&&<ChatImageExamples hasPortrait={agent.portrait.startsWith("/api/portraits/")} disabled={interactionBusy} onChoose={text=>{changeChat(text);chatInput.current?.focus();}}/>}<ChatUploadControls key={agent.id} pending={state?.userUploads||[]} selectedId={chatImage?.id} busy={interactionBusy} uploading={busy==="chat.upload"} removingId={removingUpload} visionEnabled={!!state?.config.visionEnabled} onSelect={imageId=>setSelectedChatImage(imageId?{agentId:agent.id,imageId}:null)} onUpload={uploadChatImage} onRemove={removeChatUpload}/><form onSubmit={e=>{e.preventDefault();void sendChat();}}><textarea ref={chatInput} aria-label={`发送给${agent.name}的消息`} value={chat} onChange={e=>changeChat(e.target.value)} maxLength={4000} rows={2} placeholder={chatImage?"可以补充说明，也可以直接发送图片…":state?.config.imageReady?`对${agent.name}说点什么，也可以请她发图…`:`对${agent.name}说点什么…`} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!busy&&state?.config.textReady)void sendChat();}}}/><button className="send-button" aria-label="发送消息" type="submit" disabled={interactionBusy||(!chat.trim()&&!chatImage)||!state?.config.textReady}>{busy==="chat"&&chattingAgent===agent.id?<LoaderCircle size={15} className="spin"/>:<Send size={15}/>}</button></form><p className="composer-caption">主动聊天会增加她的曝光 · Enter 发送，Shift + Enter 换行</p></div>}</aside></>}
    {leavingAgent && <DataConfirmation action={{kind:"leave",agent:leavingAgent}} busy={interactionBusy} onCancel={()=>setLeavingAgent(null)} onConfirm={async()=>{const result=await act("member.trash",{agentId:leavingAgent.id},`${leavingAgent.name}已暂时离开，可在庭院设置的回收站恢复。`);if(result)setLeavingAgent(null);}}/>}
    {toast&&<div className={`toast ${toast.error?"error":""}`} role={toast.error?"alert":"status"}>{toast.error?<CircleHelp size={15}/>:<Check size={15}/>}<span>{toast.text}</span>{toast.retry&&<button disabled={interactionBusy} onClick={toast.retry}>重试</button>}<button aria-label="关闭提示" onClick={()=>setToast(null)}><X size={14}/></button></div>}
  </div>;
}

function PageHeading({eyebrow,title,description}:{eyebrow:string;title:string;description:string}){return <div className="page-header"><div><div className="eyebrow">✦ {eyebrow}</div><h1>{title}</h1><p>{description}</p></div></div>;}

function VoiceCard({ voice, busy, onOpen, onLike }: { voice: Voice; busy: boolean; onOpen: () => void; onLike: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [voice.content, expanded]);
  const a = voice.agent;
  return <article className="feed-event">
    <div className="feed-event-heading"><button className="voice-person" onClick={onOpen} aria-label={`与${a.name}私聊`}><img src={portraitOf(a)} alt=""/><strong>{a.name}</strong></button><time dateTime={voice.createdAt}>{dayOf(voice.createdAt)} {timeOf(voice.createdAt)}</time></div>
    <div className="voice-source">{voice.private ? <LockKeyhole size={11}/> : <Layers size={11}/>}<span>{voice.source}{voice.private ? " · 仅你可见" : ""}</span></div>
    <div ref={textRef} className={expanded ? "voice-text expanded" : "voice-text"}><RichText>{voice.content}</RichText></div>
    {(clipped || expanded) && <button className="voice-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起这条发言" : "展开这条发言"}</button>}
    <div className="feed-event-actions"><button className={`voice-like ${a.liked ? "liked" : ""}`} aria-pressed={a.liked} disabled={busy} onClick={onLike}><Heart size={13} fill={a.liked ? "currentColor" : "none"}/>{a.liked ? "已偏爱" : "喜欢她"}</button><button onClick={onOpen} className="button ghost">与她聊聊<ArrowRight size={12}/></button></div>
  </article>;
}

function CharacterCard({agent:a,index,probability,busy,onOpen,onLike,onHire}:{agent:Agent;index:number;probability:number;busy:boolean;onOpen:()=>void;onLike:()=>void;onHire:()=>void}) {
  const topSkill=Object.entries(a.skills).sort((x,y)=>y[1]-x[1])[0];
  return <article className="character-card"><div className="character-portrait" role="button" tabIndex={0} aria-label={`查看${a.name}的档案`} onClick={onOpen} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onOpen();}}}><img src={portraitOf(a)} alt={a.portrait?`${a.name}的角色肖像`:`${a.name}尚未生成肖像`} loading={index<4?"eager":"lazy"}/><div className="portrait-shade"/>{!a.portrait&&<span className="portrait-placeholder-label">尚未生成肖像</span>}<span className="portrait-index">NO. {(index+1).toString().padStart(2,"0")}</span><span className="portrait-status">{a.hired?<><span className="status-dot"/>已在庭院</>:"等待相遇"}</span><div className={`portrait-name ${a.species?.kind === "synthetic" ? "synthetic" : ""}`}><h3>{a.name}</h3><span>{ageLabel(a,true)}</span></div></div><div className="character-body"><div className="role-line"><span>✧</span>{a.title}</div><div className="character-origin-tags"><SpeciesBadge agent={a}/><AppointmentBadge agent={a}/></div><p className="character-quote">“{a.tagline}”</p><div className="character-tags">{a.traits.slice(0,3).map(t=><span className="tag" key={t}>{t}</span>)}</div><div className="card-rule"/><div className="character-bottom"><div className="character-score" title={`本轮单次曝光概率约 ${Math.round(probability*100)}%`}>{SKILL_LABELS[topSkill[0] as keyof typeof SKILL_LABELS]}<strong>{topSkill[1]}</strong></div><div className="card-buttons"><button className={`favorite-btn ${a.liked?"liked":""}`} disabled={busy} onClick={onLike} aria-label={a.liked?`取消对${a.name}的偏爱`:`喜欢${a.name}`} title={a.liked?"已偏爱":"喜欢她，提高曝光"}><Heart size={13} strokeWidth={1.5} fill={a.liked?"currentColor":"none"}/></button><button className="card-chat" disabled={busy} onClick={a.hired?onOpen:onHire}>{a.hired?"与她聊聊":"邀入庭院"}<ArrowRight size={11}/></button></div></div></div></article>;
}

function OwnerAvatar({ url, name }: { url?: string; name?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const source = userAvatarUrl(url);
  return <div className="user-avatar">{source && !failed ? <img src={source} alt="你的头像" onError={() => setFailed(true)}/> : name?.slice(0, 1) || '你'}</div>;
}

function MemoryCard({memory,busy,onDelete,onSave}:{memory:Memory;busy:boolean;onDelete:()=>void;onSave:(content:string)=>Promise<unknown>}){
  const [editing,setEditing]=useState(false);const [value,setValue]=useState(memory.content);
  return <div className="memory-item">{editing?<textarea aria-label="编辑长期记忆" value={value} onChange={e=>setValue(e.target.value)} maxLength={600}/>:<p>{memory.content}</p>}<div className="memory-meta"><span title={memory.source}>{MEMORY_LABELS[memory.kind]} · {dayOf(memory.createdAt)}</span><div className="memory-meta-actions">{editing?<><button disabled={busy||!value.trim()} onClick={async()=>{const result=await onSave(value.trim());if(result)setEditing(false);}}>保存</button><button onClick={()=>{setValue(memory.content);setEditing(false);}}>取消</button></>:<><button disabled={busy} onClick={()=>setEditing(true)}>编辑</button><button disabled={busy} onClick={onDelete} aria-label="删除这条长期记忆"><Trash2 size={11}/></button></>}</div></div></div>;
}
