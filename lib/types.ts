export type Skill = 'research' | 'planning' | 'execution' | 'creativity' | 'review' | 'coordination' | 'analysis' | 'knowledge' | 'insight' | 'learning' | 'writing' | 'aesthetics' | 'empathy' | 'communication' | 'negotiation' | 'resilience';
export const SKILL_LABELS: Record<Skill, string> = { research: '研究', planning: '规划', execution: '执行', creativity: '创意', review: '审校', coordination: '协调', analysis: '分析', knowledge: '知识', insight: '洞察', learning: '学习', writing: '写作', aesthetics: '审美', empathy: '共情', communication: '表达', negotiation: '协商', resilience: '韧性' };
export const SKILL_DESCRIPTIONS: Record<Skill, string> = {
  research: '寻找线索、提出查证路径并区分信息来源；不代表已经联网检索。', analysis: '拆解因果、比较假设，把复杂问题讲成可检验的结构。', knowledge: '调用设定领域的知识并说明未知，知识面不等于全知。', insight: '识别隐含需求、动机与矛盾，推测仍须得到确认。',
  planning: '安排优先级、依赖与退路，将目标拆成有顺序的步骤。', execution: '细化交付、跟进动作并处理遗漏；不增加真实工具权限。', review: '检查事实、逻辑与边界，提出具体修正方法。', resilience: '面对失败、冷落与压力时保持稳定并恢复行动。',
  creativity: '提出差异化构想，连接原本分离的材料。', writing: '组织结构、叙事与措辞，使内容准确且有感染力。', aesthetics: '判断形式、风格与细节的一致性，并解释取舍。', learning: '吸收明确反馈、修正方法，不凭空升级能力或记忆。',
  empathy: '理解感受与处境，避免把自己的猜测当成对方真实想法。', communication: '按对象调整表达、解释观点并认真倾听。', negotiation: '讨论利益、界限与交换条件，尊重对方拒绝。', coordination: '发起分工、连接贡献并澄清责任；不等于拥有指挥权。',
};
export const SKILL_GROUPS: { id: string; label: string; description: string; skills: Skill[] }[] = [
  { id: 'understanding', label: '认知与判断', description: '如何认识问题与理解信息', skills: ['research', 'analysis', 'knowledge', 'insight'] },
  { id: 'delivery', label: '行动与稳定', description: '如何推进、检查与应对压力', skills: ['planning', 'execution', 'review', 'resilience'] },
  { id: 'creation', label: '创作与成长', description: '如何表达想象、审美与学习', skills: ['creativity', 'writing', 'aesthetics', 'learning'] },
  { id: 'social', label: '相处与协作', description: '如何理解他人并共同完成事情', skills: ['empathy', 'communication', 'negotiation', 'coordination'] },
];
export type SpeciesKind = 'human' | 'synthetic' | 'mythical' | 'spirit' | 'alien' | 'other';
export const SPECIES_KIND_LABELS: Record<SpeciesKind, string> = { human: '人类', synthetic: '人工生命', mythical: '幻想种族', spirit: '灵体', alien: '外星生命', other: '其他虚构存在' };
export interface SpeciesProfile { name: string; kind: SpeciesKind; form: string; origin: string; lifespan: string; manufacturedAt?: string; innateTraits: string[]; limitations: string[]; }
export interface CharacterProfile {
  originStory: string; formativeExperience: string; expertise: string; worldview: string; desire: string; fear: string; contradiction: string;
  habits: string[]; favorites: string[]; aversions: string[];
  socialStyle: string; trustStyle: string; rivalryStyle: string; careStyle: string; stressResponse: string; growthDirection: string; speechExamples: string[];
}
export const PROFILE_FIELD_LABELS: Record<keyof CharacterProfile, string> = { originStory: '来处与身份', formativeExperience: '塑造她的经历', expertise: '专长与弱点', worldview: '她如何看待世界', desire: '最想得到的', fear: '不愿面对的', contradiction: '内在矛盾', habits: '日常习惯', favorites: '偏爱的事物', aversions: '不喜欢的事物', socialStyle: '相处方式', trustStyle: '信任如何建立', rivalryStyle: '竞争时的选择', careStyle: '如何表达关心', stressResponse: '压力下的反应', growthDirection: '成长方向', speechExamples: '她会这样说' };
export interface Memory { id: string; kind: 'preference' | 'experience' | 'relationship' | 'strategy'; content: string; source: string; createdAt: string; updatedAt?: string; }
export interface ChatImage { status: 'ready' | 'failed'; request: string; prompt: string; url?: string; error?: string; model: string; createdAt?: string; reference?: { sourceUrl: string; mode: 'character' }; }
export interface UserImage { id: string; url: string; contentType: string; name?: string; createdAt: string; requestId?: string; }
export interface UserProfile { name: string; description: string; preferences?: string; avatar?: string; avatarPrompt?: string; updatedAt: string; }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; checked?: boolean; image?: ChatImage; attachments?: UserImage[]; }
export interface Agent {
  id: string; name: string; age: number; title: string; tagline: string; bio: string;
  traits: string[]; values: string[]; boundaries: string[]; voice: string; approach: string;
  skills: Record<Skill, number>; evidence: Partial<Record<Skill, number>>;
  skillPolicy?: 'balanced' | 'unrestricted';
  appearance: string; portrait: string; portraitPrompt?: string; portraitGeneratedAt?: string; color: string; hired: boolean; liked: boolean;
  weight: number; chatBoost: number; hiredAt?: string; createdAt: string;
  archivedAt?: string;
  strategy: string; memories: Memory[]; chats: ChatMessage[];
  appointment?: { title: string; duties: string; appointedAt: string };
  species: SpeciesProfile; profile: CharacterProfile; profileVersion?: 2; profileSource?: 'authored' | 'generated' | 'expanded' | 'derived';
}
export type ActionKind = 'propose' | 'request' | 'accept' | 'refuse' | 'challenge' | 'help' | 'submit';
export interface SocialEvent {
  id: string; taskId: string; round: number; agentId: string; kind: ActionKind;
  targetId?: string; replyTo?: string; content: string; createdAt: string; checked: boolean; adoptedAt?: string;
  actorType?: 'agent' | 'user' | 'system'; artifactIds?: string[];
}
export interface Relationship { id: string; from: string; to: string; kind: 'delegation' | 'cooperation'; taskId: string; eventId: string; createdAt: string; }
export interface Task {
  id: string; title: string; status: 'running' | 'paused' | 'completed';
  rounds: number; round: number; participants: string[]; order: string[]; cursor: number;
  createdAt: string; completedAt?: string; lastError?: string;
  artifacts?: TaskArtifact[]; toolRuns?: ToolRun[]; deliveryTurn?: number;
  mode?: 'group';
  groupTurn?: { agentId: string; eventId: string; toolCalls: number; imageCalls: number; corrected: boolean; correction: string; startedAt: string; };
  deliveryProgress?: { agentId: string; eventId: string; toolCalls: number; correction: string; startedAt: string; };
}
export interface TaskArtifact { id: string; name: string; mimeType: string; size: number; url: string; createdAt: string; agentId: string; kind?: 'file' | 'image'; contributorIds?: string[]; derivedFromIds?: string[]; eventId?: string; }
export interface ToolRun { id: string; agentId: string; tool: 'web.search' | 'web.read' | 'code.run' | 'file.write' | 'image.generate'; inputSummary: string; status: 'ok' | 'error'; output?: string; error?: string; createdAt: string; artifactIds?: string[]; }
export interface DailyEvent { id: string; agentId: string; targetId?: string; kind: 'chat' | 'support' | 'disagree' | 'propose-role' | 'endorse-role' | 'decline-role'; content: string; createdAt: string; checked: boolean; proposalId?: string; }
export interface RoleProposal { id: string; proposerId: string; holderId: string; title: string; duties: string; reason: string; createdAt: string; supporterIds: string[]; status: 'pending' | 'approved' | 'private' | 'rejected'; reviewedAt?: string; reviewNote?: string; }
export interface MembershipEvent { id: string; agentId: string; name: string; kind: 'left' | 'returned'; createdAt: string; }
export interface CleanupJob { id: string; kind: 'member' | 'all'; agentId?: string; imageIds: string[]; createdAt: string; }
export interface Settings {
  exploration: number; drama: number;
  memoryLimit?: number; groupToolLimit?: number; groupImageLimit?: number; groupArtifactLimit?: number;
}
export interface ServerConfig { textReady: boolean; imageReady: boolean; model: string; imageModel: string; visionEnabled?: boolean; }
export interface RecruitmentIssue { path: string; message: string; }
export interface RecruitmentSlot {
  slot: number; status: 'pending' | 'succeeded' | 'failed' | 'skipped'; attempts: number;
  candidate?: Agent; issues: RecruitmentIssue[]; errorCode?: string;
}
export interface RecruitmentBatch {
  id: string; brief: string; count: number; createdAt: string; updatedAt: string;
  slots: RecruitmentSlot[]; applied: boolean;
}
export interface AppState {
  userProfile?: UserProfile; userUploads?: UserImage[];
  agents: Agent[]; tasks: Task[]; events: SocialEvent[]; relationships: Relationship[];
  settings: Settings; config: ServerConfig; updatedAt: string;
  promptOverrides?: Record<string, string>;
  debugOptions?: { contentRulesEnabled: boolean };
  recruitment?: RecruitmentBatch;
  dailyEvents?: DailyEvent[]; roleProposals?: RoleProposal[]; dailyTurn?: number;
  membershipEvents?: MembershipEvent[]; pendingCleanup?: CleanupJob[];
}
export interface ApiResponse { state: AppState; message?: string; taskId?: string; error?: string; }
