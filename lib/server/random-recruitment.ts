import { z } from 'zod';
import type { AppState, RecruitmentBatch } from '../types.ts';
import { combineSystemPrompt } from '../prompts.ts';
import { PalaceError } from './errors.ts';
import { recruitmentDiversity } from './recruit-diversity.ts';
import { recruitmentNamesToAvoid } from './recruitment.ts';

export const RANDOM_RECRUITMENT_BRIEF_LIMIT = 1800;
export const randomRecruitmentRequestSchema = z.object({
  brief: z.string().max(RANDOM_RECRUITMENT_BRIEF_LIMIT).refine(value => !value.includes('\0')).optional().default(''),
  count: z.number().int().min(1).max(10).optional().default(1),
}).strict();

/** 主人，每次我会分别抽取这些创作维度，再交给模型融成新人物；这里没有可轮换的完整预制人设。 */
const CREATIVE_AXES = {
  species: ['人类', '有仿生皮肤的机器人', '外露机械构型的机器人', '原创幻想种族', '精灵或植物共生种族', '兽族或水生智慧种族', '有独特感知的外星生命', '灵体或其他非实体生命'],
  setting: ['迁徙中的浮空聚落', '普通街巷中的专业小店', '深海或地下生活圈', '文化交汇的边境', '远航后的安定生活', '复苏中的废弃设施', '季节变化显著的乡野', '技术与仪式并存的城市', '独立研究站', '跨越多个世界的交通节点'],
  vocation: ['修复与保存', '观察与调查', '烹饪或材料工艺', '表演与叙事', '导航与路线设计', '记录与知识整理', '园艺或生态照护', '协商与交易', '结构或机械设计', '旅行与地方风俗研究'],
  history: ['一次主动放弃的机会', '一项无人关注却坚持多年的工作', '从误会中重新建立信誉', '接手一个并不擅长的责任', '一次愉快经历改变了方向', '迁居后重新学习日常', '尝试摆脱外界给予的身份', '与曾经的导师走向不同道路', '在平凡生活中发明自己的方法', '保留传统同时修改其中一部分'],
  tension: ['好奇与谨慎并存', '渴望陪伴却珍惜独处', '重视规则却愿为具体的人变通', '表达热烈却不擅长求助', '讲究精确却喜欢不确定的体验', '善于照顾别人却容易忽略自己', '有竞争心却欣赏对手', '外表自信而不愿轻率承诺', '想被理解却对解释自己缺乏耐心', '爱惜旧物同时渴望重新开始'],
  expression: ['先给结论再讲一个小例子', '语速轻快但选词严谨', '用质朴比喻说明复杂事', '认真直说并偶尔自嘲', '喜欢追问具体细节', '短句与真诚的停顿', '通过故事和声音描摹感受', '克制而有干燥的幽默', '先指出可能误会再表达立场', '将观察变成轻巧的小玩笑'],
  relationship: ['一起完成不显眼的小事', '分享独特见闻与收藏', '用直接邀请争取相处时间', '主动展示自己尚不熟练的部分', '记住并兑现具体的约定', '通过有分寸的辩论拉近距离', '允许彼此保留不同意见', '以自己的专业提供有边界的帮助', '创造只有双方理解的小仪式', '坦率承认嫉妒但不代替别人作决定'],
  limitation: ['长于构思而疏于收尾', '实际操作优秀但不善组织多人', '记忆细致却难适应突发变化', '表达流畅但不擅技术细节', '耐心研究却容易错过社交暗示', '善于共情却不擅谈判', '执行稳定但面对开放问题犹豫', '审美敏锐但整理能力薄弱', '善于观察但说服别人需要时间', '学习很快却不愿承认知识盲区'],
  dailyDetail: ['与职业有关的小物件', '独特的休息习惯', '等待时的无意识动作', '对一种声音或气味的偏爱', '有来历的服装细节', '随身携带的私人记录', '面对失败时的整理仪式', '一种与外表形成反差的爱好', '对食物或能源的个人讲究', '只有熟人知道的微小执念'],
  appearance: ['自然材质与利落轮廓', '柔和配色中的一个亮色细节', '实用衣装和珍惜的旧配饰', '不对称但有生活原因的装束', '适应特定环境的身体细节', '动作方式比装饰更醒目', '精心维护却不奢华的个人物件', '与职业意外不同的审美偏好', '适合日常活动的层次与纹理', '来自故乡习惯的发型或等价外形'],
} as const;

export function randomRecruitmentAxes(random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000): Record<keyof typeof CREATIVE_AXES, string> {
  return Object.fromEntries(Object.entries(CREATIVE_AXES).map(([axis, choices]) => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机采样值需要在0至1之间。');
    return [axis, choices[Math.floor(value * choices.length)]];
  })) as Record<keyof typeof CREATIVE_AXES, string>;
}

export type RecruitmentIdeaGenerate = (system: string, input: unknown, maxTokens: number, timeoutMs: number) => Promise<unknown>;

export async function createRandomRecruitmentBrief(state: AppState, input: unknown, generate: RecruitmentIdeaGenerate, options: { random?: () => number; nonce?: string } = {}): Promise<{ brief: string }> {
  const parsed = randomRecruitmentRequestSchema.safeParse(input);
  if (!parsed.success) throw new PalaceError('人物方向最多1800字，寻访数量需要是1至10之间的整数。', 400, 'RECRUITMENT_IDEA_INPUT_INVALID');
  const { brief, count } = parsed.data;
  const nonce = options.nonce || crypto.randomUUID();
  // 我只借用公开档案摘要来避开雷同，主人的私聊、记忆和个人资料不会被带进这次创作哦。
  const contextBatch: RecruitmentBatch = { id: nonce, brief, count, createdAt: '', updatedAt: '', slots: state.recruitment?.slots || [], applied: false };
  const diversity = recruitmentDiversity(state, contextBatch, 1);
  const result = await generate(combineSystemPrompt('recruiter.idea', state.promptOverrides), {
    direction: brief.trim(), requestedCount: count, nonce,
    creativeAxes: randomRecruitmentAxes(options.random),
    diversity: { totalKnownCharacters: diversity.totalKnownCharacters, existingCharacters: diversity.existingCharacters, repeatedDetails: diversity.repeatedDetails },
    existingNamesToAvoid: recruitmentNamesToAvoid(state),
    output: { brief: '中文招募需求，建议350至900字，不超过1800字符；只返回一个brief字符串字段。' },
  }, 2600, 75_000);
  const output = z.object({ brief: z.string().trim().min(100).max(RANDOM_RECRUITMENT_BRIEF_LIMIT).refine(value => !value.includes('\0')) }).strict().safeParse(result);
  if (!output.success) throw new PalaceError('随机人物设定未通过格式或长度检查，请重试或手动填写。', 502, 'RECRUITMENT_IDEA_INVALID');
  return output.data;
}
