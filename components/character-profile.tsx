"use client";

import { useState } from "react";
import { BookOpen, Check, ChevronRight, Dna, Feather, Heart, ImagePlus, Layers, LoaderCircle, MessageCircle, Sparkles, Sprout, WandSparkles } from "lucide-react";
import type { Agent, Skill } from "@/lib/types";
import { SKILL_DESCRIPTIONS, SKILL_GROUPS, SKILL_LABELS, SPECIES_KIND_LABELS } from "@/lib/types";
import { RichText } from "@/components/rich-text";

const SECTIONS = [
  { id: "identity", label: "身世与族裔", icon: Dna },
  { id: "inner", label: "内心底色", icon: Heart },
  { id: "social", label: "相处方式", icon: MessageCircle },
  { id: "abilities", label: "16 维能力", icon: Layers },
  { id: "voice", label: "习惯与声音", icon: Feather },
  { id: "growth", label: "边界与成长", icon: Sprout },
] as const;
type SectionId = typeof SECTIONS[number]["id"];

export function ageLabel(agent: Agent, compact = false) {
  const kind = agent.species?.kind || "human";
  if (kind === "human") return `${agent.age} 岁`;
  if (kind === "synthetic") return agent.species.manufacturedAt ? `制造于 ${agent.species.manufacturedAt}` : "制造日期待补充";
  return `${compact ? "" : "存续 "}${agent.age} 年`;
}

export function SpeciesBadge({ agent }: { agent: Agent }) {
  const species = agent.species;
  return <span className={`species-badge ${species?.kind || "human"}`} title={species ? `${SPECIES_KIND_LABELS[species.kind]} · ${ageLabel(agent)}` : "原有的人类角色设定"}><Dna size={11}/><span>{species?.name || "人类"}</span></span>;
}

function DossierText({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  if (!value) return null;
  return <section className={`dossier-text ${accent ? "accent" : ""}`}><h4>{label}</h4><RichText>{value}</RichText></section>;
}

function DossierList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return <section className="dossier-list"><h4>{label}</h4><ul>{items.map((item, i) => <li key={`${i}-${item}`}><span>✧</span><RichText>{item}</RichText></li>)}</ul></section>;
}

function levelOf(score: number) {
  return score >= 85 ? "核心专长" : score >= 70 ? "擅长" : score >= 50 ? "熟练" : "需要协助";
}

function AbilityMatrix({ agent }: { agent: Agent }) {
  const total = Object.values(agent.skills).reduce((sum, value) => sum + value, 0);
  const evidence = Object.entries(agent.evidence).filter(([, count]) => Number(count) > 0) as [Skill, number][];
  return <>
    <div className="dossier-ability-summary"><div><strong>16</strong><span>能力维度</span></div><div><strong>{total}</strong><span>能力总额</span></div><div><strong>{Object.values(agent.skills).filter(value => value < 50).length}</strong><span>需要协助的领域</span></div></div>
    <p className="dossier-explanation">{agent.skillPolicy === "unrestricted" ? "本角色采用自由配分，保留生成时的 0–100 分原值，不要求总额为 960。" : "本角色采用默认能力配分，总额为 960，各项 15–95 分。"}能力是人物设定中的相对专长，影响承担任务、质疑与求助的方式。高分不代表现实实测成绩，种族天赋也不能越过工具与权限边界。</p>
    <DossierText label="她的专业积累" value={agent.profile.expertise}/>
    <div className="dossier-ability-groups">{SKILL_GROUPS.map(group => <section className="dossier-ability-group" key={group.id}><header><h4>{group.label}</h4><p>{group.description}</p></header><div className="dossier-skill-list">{group.skills.map(skill => {
      const score = agent.skills[skill];
      return <div key={skill} className={`dossier-skill ${score < 50 ? "weak" : ""}`}><div className="dossier-skill-heading"><strong>{SKILL_LABELS[skill]}</strong><span>{levelOf(score)}</span><b>{score}</b></div><div className="dossier-skill-track" role="meter" aria-label={SKILL_LABELS[skill]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score}><i style={{ width: `${score}%` }}/></div><p>{SKILL_DESCRIPTIONS[skill]}</p></div>;
    })}</div></section>)}</div>
    <DossierText label="她实际怎样做事" value={agent.approach}/>
    <section className="dossier-evidence"><h4><Check size={13}/>你已采纳的实际贡献</h4><p>这里记录真实的采纳次数，与上面的设定能力分开。</p>{evidence.length ? <div>{evidence.map(([skill, count]) => <span key={skill}>{SKILL_LABELS[skill]} <strong>{count} 次</strong></span>)}</div> : <div className="dossier-empty">还没有被采纳的贡献。共同完成事务后，认可她的成果会留下记录。</div>}</section>
  </>;
}

export function CharacterProfile({ agent, busy, enriching, generating, textReady, imageReady, onEnrich, onPortrait, onCopy }: {
  agent: Agent;
  busy: boolean;
  enriching: boolean;
  generating: boolean;
  textReady: boolean;
  imageReady: boolean;
  onEnrich: () => Promise<unknown>;
  onPortrait: () => Promise<unknown>;
  onCopy: (text: string) => void;
}) {
  const [section, setSection] = useState<SectionId>("identity");
  const species = agent.species, profile = agent.profile;
  if (!species || !profile) return <div className="dossier-legacy"><DossierText label="已有的人物档案" value={agent.bio}/><p className="dossier-explanation">详细族裔、经历与能力档案正在升级。重新载入庭院后即可查看；原有人设不会改变。</p></div>;
  const source = agent.profileSource || "derived";
  const wordCount = Object.values(profile).reduce((sum, value) => sum + (Array.isArray(value) ? value.join("").length : value.length), 0);
  return <div className="character-dossier">
    <div className="dossier-overview"><div><span className="eyebrow">A WORLD WITHIN</span><h3>她的世界，不止一面。</h3></div><span className={`dossier-source ${source}`}>{source === "authored" ? "完整设定" : source === "generated" ? "招募档案" : source === "expanded" ? "已补充详历" : "原资料整理"}</span></div>
    <div className="dossier-overview-meta"><span>{SPECIES_KIND_LABELS[species.kind]} · {species.name}</span><span>16 项能力</span><span>人物详历 {wordCount.toLocaleString()} 字符</span></div>
    {source === "derived" && <div className="dossier-enrich"><BookOpen size={17}/><div><strong>已有经历，可以写得更完整。</strong><p>当前档案根据原有资料整理。补充时会扩写身世、内心与相处细节，保留既有身份和能力；会调用文本 API。</p><button className="button secondary small" disabled={busy || !textReady} onClick={() => void onEnrich()}>{enriching ? <LoaderCircle size={12} className="spin"/> : <Sparkles size={12}/>} {enriching ? "正在补充详细档案…" : "补充详细档案"}</button></div></div>}
    <nav className="dossier-nav" aria-label="详细人物档案分类">{SECTIONS.map(item => <button key={item.id} className={section === item.id ? "active" : ""} aria-pressed={section === item.id} onClick={event => { setSection(item.id); event.currentTarget.closest(".drawer-content")?.scrollTo({ top: 0, behavior: "smooth" }); }}><item.icon size={13}/>{item.label}</button>)}</nav>
    <div className="dossier-section" key={section}>
      {section === "identity" && <>
        <DossierText label="初识她" value={agent.bio}/>
        <section className="dossier-species"><header><Dna size={15}/><h4>{species.name}</h4><span>{SPECIES_KIND_LABELS[species.kind]}</span></header><dl><dt>{species.kind === "synthetic" ? "制造日期" : "生命历程"}</dt><dd>{species.kind === "synthetic" ? species.manufacturedAt || "制造日期待补充" : ageLabel(agent)}</dd><dt>形态与载体</dt><dd>{species.form}</dd><dt>世界与族裔来历</dt><dd>{species.origin}</dd><dt>生命尺度</dt><dd>{species.lifespan}</dd></dl></section>
        <DossierText label="她从哪里来" value={profile.originStory}/>
        <DossierText label="塑造她的那段经历" value={profile.formativeExperience}/>
        <DossierList label="与生俱来的族裔特质" items={species.innateTraits}/>
        <details className="dossier-portrait"><summary><ImagePlus size={14}/><span>外观与专属肖像</span><ChevronRight size={14}/></summary><div><DossierText label="固定外貌设定" value={agent.appearance}/><p className="dossier-explanation">{imageReady ? "按她的族裔、形态与固定外貌设定生成肖像。每次点击会调用图片模型并产生费用。" : "图片服务尚未配置。前往庭院设置配置后，就能为她生成专属肖像。"}</p><button className="button secondary full" disabled={busy || !imageReady} onClick={() => void onPortrait()}>{generating ? <LoaderCircle size={14} className="spin"/> : <WandSparkles size={14}/>}生成她的肖像</button>{agent.portraitPrompt && <details className="portrait-prompt"><summary>查看肖像生成提示词</summary><p>{agent.portraitPrompt}</p><button className="button secondary small" onClick={() => onCopy(agent.portraitPrompt || "")}>复制提示词</button></details>}</div></details>
      </>}
      {section === "inner" && <><DossierText label="她如何理解这个世界" value={profile.worldview}/><DossierText label="她真正渴望的事" value={profile.desire}/><DossierText label="她不轻易说出口的恐惧" value={profile.fear}/><DossierText label="她身上的矛盾" value={profile.contradiction} accent/><DossierList label="不会轻易动摇的价值观" items={agent.values}/></>}
      {section === "social" && <><DossierText label="初次相处，她怎样靠近" value={profile.socialStyle}/><DossierText label="她怎样建立与交付信任" value={profile.trustStyle}/><DossierText label="争取偏爱时，她自己的方式" value={profile.rivalryStyle} accent/><DossierText label="她如何表达关心" value={profile.careStyle}/><div className="dossier-context-note"><Heart size={13}/><p>这些是她的人格底色。经历可以改变她的具体策略；此刻的打算，请在「记忆与策略」中查看。</p></div></>}
      {section === "abilities" && <AbilityMatrix agent={agent}/>}
      {section === "voice" && <><DossierList label="日常的小习惯" items={profile.habits}/><DossierList label="让她心生欢喜的事" items={profile.favorites}/><DossierList label="让她本能退后的事" items={profile.aversions}/><DossierText label="声音、措辞与表达节奏" value={agent.voice}/><section className="dossier-speech"><h4>听见她的语气</h4><p>档案中的说话示例，展示人设表达方式。</p>{profile.speechExamples.map((line, index) => <blockquote key={index}><span>“</span><RichText>{line}</RichText></blockquote>)}</section></>}
      {section === "growth" && <><DossierList label="即使想讨你喜欢，也不会越过的边界" items={agent.boundaries}/><DossierList label="族裔与形态的限制" items={species.limitations}/><DossierText label="压力之下，她如何反应" value={profile.stressResponse}/><DossierText label="她可能慢慢长成的样子" value={profile.growthDirection} accent/><div className="dossier-context-note"><Sprout size={14}/><p>成长方向描述她可以怎样积累经验，不会直接重写身份、消除短板或授予新的工具权限。</p></div></>}
    </div>
  </div>;
}
