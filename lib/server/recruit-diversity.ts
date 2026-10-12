import type { Agent, AppState, CharacterProfile, RecruitmentBatch, RecruitmentIssue, Skill } from "../types.ts";

type PublicCharacter = Pick<Agent, "name" | "title" | "traits" | "voice" | "approach" | "appearance" | "species" | "profile" | "skills">;
type DetailGroup = "background" | "motivation" | "interaction" | "expression" | "daily";
type DetailField = { path: string; group: DetailGroup; text: string };

/** 主人，这些只是可选的创意切入角度，不是种族、性格或技能的指定项。 */
const ANGLES = {
  background: ["一次主动转轨", "长期专注的小领域", "不同环境之间的适应", "一次失误后的修正", "某项责任的交接", "从模仿到自己的方法", "一次被误解的成果", "普通日常中的转折", "一段未完成的计划", "从孤独工作到与人协作"],
  motivation: ["归属与独立的拉扯", "好奇心与谨慎的拉扯", "被看见与保持隐私的拉扯", "可靠形象与真实弱点的拉扯", "熟悉秩序与新体验的拉扯", "个人标准与他人需要的拉扯", "及时回应与认真思考的拉扯", "竞争愿望与承认他人的拉扯", "坚持约定与临场变通的拉扯", "保存过去与重新开始的拉扯"],
  expression: ["具体物件的比喻", "先追问一个细节", "简短结论后补充理由", "细微而克制的幽默", "借小故事解释想法", "先复述对方再回应", "自我修正的停顿", "用对比说明取舍", "用步骤安排叙述", "坦率说出一个疑问"],
  relationship: ["共同完成小事", "认真记住约定", "展示尚不熟练的一面", "分享独特观察", "提供有边界的照料", "邀请对方作出选择", "主动承认一次误判", "维护共同成果的署名", "为不同意见留空间", "以稳定的小仪式靠近"],
  daily: ["整理物件的习惯", "记录灵感的方式", "休息时的小仪式", "选择配饰的缘由", "表达不耐烦的细节", "等待回应时的动作", "保管纪念物的方式", "探索新事物的顺序", "准备开始工作的小动作", "遇到难题时的自我安顿"],
  ability: ["主强项与沟通方式的反差", "专长与日常短板的反差", "理论理解与动手节奏的差别", "熟悉领域与陌生领域的差别", "个人工作与合作习惯的差别", "观察能力与表达能力的差别", "创意速度与复核耐心的差别", "稳定交付与临场变通的差别", "学习意愿与知识盲区的差别", "组织能力与情绪韧性的差别"],
  appearance: ["服装剪裁的辨识点", "惯常姿态与表情", "有来历的小配饰", "发型或等价外形轮廓", "配色中的一个小对比", "材质选择与生活方式", "手部或等价肢体的小细节", "装饰物的个人用途", "日常装束的实用细节", "活动时的视觉特征"],
} as const;

export interface RecruitmentCharacterSummary {
  name: string; title: string; status: "member" | "candidate" | "archived" | "batch-success";
  species: string; traits: string[]; background: string; formativeExperience: string;
  motivation: string; voice: string; interaction: string; daily: string; appearance: string;
  strongestSkills: { skill: Skill; value: number }[]; weakestSkills: { skill: Skill; value: number }[];
}
export interface RecruitmentDiversity {
  totalKnownCharacters: number;
  existingCharacters: RecruitmentCharacterSummary[];
  repeatedDetails: { field: string; value: string; count: number }[];
  assignedVariation: Record<keyof typeof ANGLES, string>;
  slot: number;
  requestedCount: number;
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
function hash(text: string): number {
  let result = 2166136261;
  for (const character of text) result = Math.imul(result ^ character.codePointAt(0)!, 16777619);
  return result >>> 0;
}

export function recruitmentKnownCharacters(state: AppState, batch = state.recruitment): Agent[] {
  const known = new Map(state.agents.map(agent => [agent.id, agent]));
  for (const slot of batch?.slots || []) if (slot.status === "succeeded" && slot.candidate) known.set(slot.candidate.id, slot.candidate);
  return [...known.values()];
}

function summarize(agent: Agent, batch: RecruitmentBatch | undefined): RecruitmentCharacterSummary {
  const ranked = Object.entries(agent.skills).sort((a, b) => b[1] - a[1]);
  const skills = (entries: typeof ranked) => entries.map(([skill, value]) => ({ skill: skill as Skill, value }));
  return {
    name: agent.name, title: agent.title,
    status: agent.archivedAt ? "archived" : agent.hired ? "member" : batch?.slots.some(slot => slot.candidate?.id === agent.id && slot.status === "succeeded") ? "batch-success" : "candidate",
    species: `${agent.species.kind} / ${agent.species.name}`,
    traits: agent.traits.slice(0, 4).map(value => clip(value, 30)),
    background: clip(agent.profile.originStory, 80), formativeExperience: clip(agent.profile.formativeExperience, 80),
    motivation: [agent.profile.desire, agent.profile.fear, agent.profile.contradiction].map(value => clip(value, 42)).join(" / "),
    voice: clip(agent.voice, 80), interaction: [agent.profile.socialStyle, agent.profile.rivalryStyle, agent.profile.careStyle].map(value => clip(value, 42)).join(" / "),
    daily: clip([...agent.profile.habits, ...agent.profile.favorites].join(" / "), 90), appearance: clip(agent.appearance, 150),
    strongestSkills: skills(ranked.slice(0, 3)), weakestSkills: skills(ranked.slice(-3).reverse()),
  };
}

export function recruitmentDiversity(state: AppState, batch: RecruitmentBatch, slot: number): RecruitmentDiversity {
  const known = recruitmentKnownCharacters(state, batch);
  const counts = new Map<string, { field: string; value: string; count: number }>();
  for (const agent of known) {
    const details: [string, string][] = [
      ...agent.traits.map(value => ["traits", value] as [string, string]),
      ...agent.profile.habits.map(value => ["profile.habits", value] as [string, string]),
      ...agent.profile.favorites.map(value => ["profile.favorites", value] as [string, string]),
      ["voice", agent.voice], ["profile.desire", agent.profile.desire], ["profile.originStory", agent.profile.originStory],
    ];
    for (const [field, value] of new Map(details.map(([field, value]) => [`${field}:${normalized(value)}`, [field, value] as [string, string]])).values()) {
      const key = `${field}:${normalized(value)}`;
      const prior = counts.get(key);
      if (prior) prior.count++; else counts.set(key, { field, value: clip(value, 100), count: 1 });
    }
  }
  // 主人，优先纳入本批次候选，再纳入近期保留角色；完整集合仍参与重复检测。
  const selected = known.slice().sort((a, b) => {
    const pending = (agent: Agent) => batch.slots.some(item => item.status === "succeeded" && item.candidate?.id === agent.id) ? 1 : 0;
    return pending(b) - pending(a) || b.createdAt.localeCompare(a.createdAt);
  }).slice(0, 24);
  const assignedVariation = Object.fromEntries(Object.entries(ANGLES).map(([axis, choices]) => {
    // 主人，每个创意轴做一次排列，避免两个并发调用拿到相同的创意槽位。
    const offset = hash(`${batch.id}:${axis}`) % choices.length;
    const stride = [1, 3, 7, 9][hash(`${axis}:${batch.id}`) % 4];
    return [axis, choices[(offset + (slot - 1) * stride) % choices.length]];
  })) as Record<keyof typeof ANGLES, string>;
  return {
    totalKnownCharacters: known.length,
    existingCharacters: selected.map(agent => summarize(agent, batch)),
    repeatedDetails: [...counts.values()].filter(detail => detail.count > 1).sort((a, b) => b.count - a.count).slice(0, 16),
    assignedVariation, slot, requestedCount: batch.count,
  };
}

function detailFields(person: PublicCharacter): DetailField[] {
  const profileGroups: [DetailGroup, (keyof CharacterProfile)[]][] = [
    ["background", ["originStory", "formativeExperience", "expertise"]],
    ["motivation", ["worldview", "desire", "fear", "contradiction", "growthDirection"]],
    ["interaction", ["socialStyle", "trustStyle", "rivalryStyle", "careStyle", "stressResponse"]],
    ["daily", ["habits", "favorites", "aversions"]],
    ["expression", ["speechExamples"]],
  ];
  return [
    ...profileGroups.flatMap(([group, keys]) => keys.map(key => ({ path: `profile.${key}`, group, text: Array.isArray(person.profile[key]) ? person.profile[key].join("；") : person.profile[key] as string }))),
    { path: "voice", group: "expression", text: person.voice },
    { path: "approach", group: "interaction", text: person.approach },
  ];
}

function grams(text: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < text.length - 3; index++) result.add(text.slice(index, index + 4));
  return result;
}
function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const a = grams(left); const b = grams(right);
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return (2 * intersection) / Math.max(1, a.size + b.size);
}

function normalizedDetail(text: string, name: string): string {
  const clean = normalized(text); const nameKey = normalized(name);
  return nameKey.length >= 2 ? clean.split(nameKey).join("") : clean;
}

function requestsIdenticalDossier(brief: string): boolean {
  // 主人，共享种族、外貌或职业并不等于要求复制完整角色档案。
  const wholeDossier = [
    /(?:完全相同|一模一样)(?:的)?(?:人物设定|人物档案|人格|性格|角色|人物|克隆角色)|同一(?:个)?人格/giu,
    /(?:所有|全部|整套|全套|完整|其余|其他)(?:的)?(?:人物|角色)?(?:设定|档案)[^。！？；\n]{0,35}?(?:保持一致|一致|相同|不变|照搬|沿用|一样)/giu,
    /(?:照搬|沿用|复制|复用|保留|复刻)[^。！？；\n]{0,25}?(?:全部|所有|整套|全套|完整)(?:的)?(?:人物|角色)?(?:设定|档案)/giu,
    /(?:除|除了)(?:姓名|名字|名称)[^。！？；\n]{0,30}?(?:设定|其他|其余)[^。！？；\n]{0,20}?(?:不变|一致|相同|一样|沿用|照搬)/giu,
    /(?:仅|只)(?:改|换|更换|修改)(?:一个|个)?(?:名字|姓名)[^。！？；\n]{0,20}?(?:其他|其余|设定)[^。！？；\n]{0,15}?(?:不变|一致|相同|一样)/giu,
    /(?:identical\s+(?:characters|personalities|dossiers)|same\s+(?:exact\s+)?(?:character|personality|dossier)|(?:copy|reuse)\s+(?:the\s+)?(?:entire|whole|full)\s+(?:character|personality|dossier))/giu,
  ];
  const negation = /(?:不要|不能|不必|不允许|禁止|避免|拒绝|不想|不需要|并非|而非|不是|无需|别|\bnot\b|\bavoid\b|\bno\b|\bdon['’]?t\b)/iu;
  for (const pattern of wholeDossier) {
    for (const match of brief.matchAll(pattern)) {
      const prefix = brief.slice(Math.max(0, match.index! - 16), match.index).split(/[，,。！？；;\n]/u).at(-1) || "";
      if (negation.test(prefix) || negation.test(match[0])) continue;
      // 主人，「外观完全相同的角色」这样的描述仍然允许经历和性格自由发挥。
      if (/^(?:完全相同|一模一样)/u.test(match[0]) && /(?:外观|外貌|衣服|服装|发型|种族|职业|技能|能力|方向|风格|型号|模型)[^，,。！？；;\n]{0,8}$/u.test(prefix)) continue;
      return true;
    }
  }
  return false;
}

/** 主人，只拒绝多维度近乎复制的完整档案；共享种族、外貌、技能或性格标签不构成拒绝理由。 */
export function recruitmentDiversityIssues(person: PublicCharacter, known: PublicCharacter[], brief: string): RecruitmentIssue[] {
  // 主人，如果用户明确要求相同角色则允许通过；其他情况下各项细节可以自由调整。
  if (requestsIdenticalDossier(brief)) return [];
  const briefKey = normalized(brief);
  const fields = detailFields(person).map(field => ({ ...field, text: normalizedDetail(field.text, person.name) })).filter(field => field.text.length >= 20 && !briefKey.includes(field.text));
  if (fields.length < 7) return [];
  for (const existing of known) {
    const reference = new Map(detailFields(existing).map(field => [field.path, normalizedDetail(field.text, existing.name)]));
    const matching = fields.filter(field => {
      const other = reference.get(field.path) || "";
      return other.length >= 20 && similarity(field.text, other) >= 0.94;
    });
    if (matching.length < 7 || matching.length / fields.length < 0.65 || new Set(matching.map(field => field.group)).size < 3) continue;
    return matching.slice(0, 4).map(field => ({ path: `candidates.0.${field.path}`, message: `与「${existing.name}」的人物细节近乎复制（至少${matching.length}项涉及多个方面）。保留招募要求，重写未指定的经历、动机、行为和表达细节，再重新生成本项。` }));
  }
  return [];
}
