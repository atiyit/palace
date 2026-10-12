import type { AppState } from './types.ts';

export interface ContentValidationOptions { contentRulesEnabled: boolean; }

export function contentValidationOptions(state: Pick<AppState, 'debugOptions'>): ContentValidationOptions {
  return { contentRulesEnabled: state.debugOptions?.contentRulesEnabled !== false };
}

/** 请容我把内容策略随模型输入一并递过去——不过主人请放心，服务端仍然会对每一条回复独立做校验哦。 */
export function contentValidationPolicy(state: Pick<AppState, 'debugOptions'>) {
  const { contentRulesEnabled } = contentValidationOptions(state);
  return {
    contentRulesEnabled,
    age: contentRulesEnabled ? '非机器人为21至10000的整数；机器人兼容age填0并记录制造日期。' : '年龄为非负安全整数，不限制21至10000区间；机器人记录制造日期，兼容age填0。',
    detail: contentRulesEnabled ? 'bio至少100字符，完整profile共700至12000字符；traits至少3项，values与boundaries至少2项，speechExamples至少2句。' : '保留全部字段、非空文本和非空数组，不要求bio或profile的最低总字数，也不要求多个条目；篇幅服从当前需求。',
    skills: contentRulesEnabled ? '完整16维，15至95整数，按960总预算与至少两项低于50的规则平衡。' : '完整16维，保留0至100整数原值，不强制960总预算或弱项数量。',
    unchanged: 'JSON结构、字段类型、种族类别、有效制造日期、文本与数组容量上限仍有效；人设一致性、事实与权限审校继续生效。',
  };
}
