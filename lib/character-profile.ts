import { SKILL_LABELS, type Agent, type AppState, type CharacterProfile, type Skill, type SpeciesProfile } from './types.ts';
import { SEED_PROFILES } from './seed-profiles.ts';
import { stripDeprecatedPromptTokens } from './prompts.ts';

export const LEGACY_SKILLS: Skill[] = ['research', 'planning', 'execution', 'creativity', 'review', 'coordination'];
export const ALL_SKILLS = Object.keys(SKILL_LABELS) as Skill[];
export const NEW_SKILLS = ALL_SKILLS.filter(skill => !LEGACY_SKILLS.includes(skill));
export const SKILL_BUDGET = 960;
const bounded = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(15, Math.min(95, Math.round(value))) : 60;

function allocate(keys: Skill[], input: Partial<Record<Skill, number>>, budget: number, weakCount: number): Partial<Record<Skill, number>> {
  const raw = Object.fromEntries(keys.map(key => [key, bounded(input[key])])) as Record<Skill, number>;
  const weak = new Set([...keys].sort((a, b) => raw[a] - raw[b] || keys.indexOf(a) - keys.indexOf(b)).slice(0, weakCount));
  const total = keys.reduce((sum, key) => sum + raw[key], 0);
  const result = Object.fromEntries(keys.map(key => [key, Math.max(15, Math.min(weak.has(key) ? 49 : 95, Math.round(raw[key] * budget / total)))])) as Record<Skill, number>;
  let difference = budget - keys.reduce((sum, key) => sum + result[key], 0);
  while (difference) {
    let changed = false;
    for (const key of keys) {
      if (!difference) break;
      if (difference > 0 && result[key] < (weak.has(key) ? 49 : 95)) { result[key]++; difference--; changed = true; }
      else if (difference < 0 && result[key] > 15) { result[key]--; difference++; changed = true; }
    }
    if (!changed) throw new Error('能力预算无法在约束内分配。');
  }
  return result;
}

export function normalizeCharacterSkills(input: Partial<Record<Skill, number>>): Record<Skill, number> {
  return allocate(ALL_SKILLS, input, SKILL_BUDGET, 2) as Record<Skill, number>;
}

/** 主人，旧版六维数值会原样保留；新增维度是从已有属性显式推导的先验值。 */
export function upgradeSkills(input: Partial<Record<Skill, number>>): Record<Skill, number> {
  if (ALL_SKILLS.every(key => typeof input[key] === 'number' && Number.isFinite(input[key]))) {
    const values = ALL_SKILLS.map(key => input[key]!);
    if (values.every(value => Number.isInteger(value) && value >= 15 && value <= 95) && values.reduce((a, b) => a + b, 0) === SKILL_BUDGET && values.filter(value => value < 50).length >= 2) return Object.fromEntries(ALL_SKILLS.map(key => [key, input[key]!])) as Record<Skill, number>;
    return normalizeCharacterSkills(input);
  }
  const legacy = Object.fromEntries(LEGACY_SKILLS.map(key => [key, bounded(input[key])])) as Record<Skill, number>;
  const { research: r, planning: p, execution: e, creativity: c, review: v, coordination: o } = legacy;
  const derived: Partial<Record<Skill, number>> = {
    analysis: (r + p + v) / 3, knowledge: .8 * r + .2 * v, insight: .45 * p + .35 * r + .2 * o,
    learning: .55 * r + .45 * c, writing: .55 * c + .45 * v, aesthetics: .8 * c + .2 * v,
    empathy: .65 * o + .35 * e, communication: .65 * o + .35 * c,
    negotiation: .55 * o + .45 * p, resilience: .55 * e + .45 * v,
  };
  const weak = LEGACY_SKILLS.filter(key => legacy[key] < 50).length;
  return { ...legacy, ...allocate(NEW_SKILLS, derived, SKILL_BUDGET - LEGACY_SKILLS.reduce((sum, key) => sum + legacy[key], 0), Math.max(0, 2 - weak)) } as Record<Skill, number>;
}

export function humanSpecies(agent: Pick<Agent, 'age' | 'appearance'>): SpeciesProfile {
  return {
    name: '人类', kind: 'human', form: `具有成年人类外形；固定外貌沿用原档案：${agent.appearance}`,
    origin: '现有档案中的人类背景，未追加未证实的出生地点或家族设定。', lifespan: '普通人类的时间尺度，不设超自然寿命。',
    innateTraits: ['人类的感知、情感与学习方式；具体才能以个人能力档案为准'],
    limitations: ['没有因种族设定获得超自然能力', '现实行动能力仍取决于实际接入的工具'],
  };
}

function derivedProfile(agent: Agent): CharacterProfile {
  const best = [...ALL_SKILLS].sort((a, b) => agent.skills[b] - agent.skills[a]).slice(0, 3).map(key => SKILL_LABELS[key]).join('、');
  const weak = [...ALL_SKILLS].sort((a, b) => agent.skills[a] - agent.skills[b]).slice(0, 2).map(key => SKILL_LABELS[key]).join('、');
  return {
    originStory: `依据原档案整理：${agent.bio} 原档案未记载的家族、地域与童年不补写为事实。`,
    formativeExperience: `可确认的经历范围来自上述背景及已保存的真实互动。目前不能仅由「${agent.title}」推断具体人生事件；进一步细节需要主动扩写并审查。`,
    expertise: `现有专长先验偏向${best}，相对弱项为${weak}。新增维度由原六维确定性推导，不是新完成的测试。`,
    worldview: `原有价值取向是${agent.values.join('、')}；遇到冲突时先沿用这些取向，不凭空增加政治、宗教或群体立场。`,
    desire: `按已有相处方式，她希望这样争取关注：${agent.approach}`,
    fear: `可确定她不愿越过的边界是：${agent.boundaries.join('；')}。尚未设定的创伤或恐惧不能当作既往事实。`,
    contradiction: `她会面对争取偏爱与保留自身判断之间的张力，具体表现受${agent.traits.join('、')}约束；尚未确认更具体的性格矛盾。`,
    habits: [`可观察的表达习惯：${agent.voice}`], favorites: [`已知珍视：${agent.values.join('、')}；具体食物、音乐等偏好尚待设定`],
    aversions: agent.boundaries.map(boundary => `不会接受的行为：${boundary}`),
    socialStyle: `相处基调沿用${agent.traits.join('、')}。${agent.approach}`,
    trustStyle: `信任依据实际交流与有来源的记忆建立；目前的策略是：${agent.strategy}`,
    rivalryStyle: `竞争方式以现有人设为界：${agent.approach} 不能因新字段而自动获得更强能力或已存在的盟友。`,
    careStyle: `关心的表达可沿用原有方式：${agent.voice} 哪种表达被接受，需要从本人收到的真实反馈确认。`,
    stressResponse: `承受压力时仍保留${agent.traits.join('、')}的底色，并遵守${agent.values.join('、')}；原档案未写明的极端反应不作确定判断。`,
    growthDirection: `可以在${weak}相关任务中求助和积累经验，同时让${best}更贴合实际需求；改变方法不等于改写核心价值。`,
    speechExamples: [agent.tagline, `表达基准（设定说明，并非已发生台词）：${agent.voice}`],
  };
}

export function profileTextLength(profile: CharacterProfile): number {
  return Object.values(profile).reduce((sum, value) => sum + (Array.isArray(value) ? value.join('').length : value.length), 0);
}

export function upgradeAgent(agent: Agent): Agent {
  // 主人，角色会保留创建时使用的分配策略，即使调试选项后来发生了变化也不会受影响。
  agent.skills = agent.skillPolicy === 'unrestricted'
    ? Object.fromEntries(ALL_SKILLS.map(key => {
      const value = agent.skills[key];
      return [key, typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 60];
    })) as Record<Skill, number>
    : upgradeSkills(agent.skills);
  if (!agent.species) agent.species = humanSpecies(agent);
  Reflect.deleteProperty(agent.species, 'adultBasis');
  if (!agent.profile) {
    const authored = SEED_PROFILES[agent.id];
    if (authored && authored.name === agent.name && agent.species.kind === 'human') {
      agent.profile = structuredClone(authored.profile); agent.profileSource = 'authored';
    } else { agent.profile = derivedProfile(agent); agent.profileSource = 'derived'; }
  }
  agent.profileSource ??= 'derived';
  agent.profileVersion = 2;
  return agent;
}

export function upgradeAppState(state: AppState): AppState {
  state.agents.forEach(upgradeAgent);
  state.recruitment?.slots.forEach(slot => { if (slot.candidate) upgradeAgent(slot.candidate); });
  for (const [id, text] of Object.entries(state.promptOverrides || {})) {
    const clean = stripDeprecatedPromptTokens(text);
    if (clean === text) continue;
    if (clean.trim()) state.promptOverrides![id] = clean;
    else delete state.promptOverrides![id];
  }
  return state;
}
