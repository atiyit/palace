import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { dailyContext, dailyStep, privateRoleConsensus, reviewRoleProposal, type DailyDependencies } from '../lib/server/daily-life.ts';
import type { AppState, DailyEvent, RoleProposal } from '../lib/types.ts';
import { PalaceError } from '../lib/server/errors.ts';

const NOW = '2026-10-12T16:00:00.000Z';
function members(count = 3): AppState {
  const state = createInitialState();
  state.agents = state.agents.slice(0, count);
  state.agents.forEach(agent => { agent.hired = true; });
  return state;
}
function scripted(values: unknown[], extras: Partial<DailyDependencies> = {}) {
  const calls: { system: string; input: Record<string, unknown>; maxTokens: number; timeoutMs: number }[] = [];
  let index = 0;
  const deps: DailyDependencies = {
    prompt: id => id, id: () => `daily-generated-${++index}`, now: () => NOW,
    generate: async (system, input, maxTokens, timeoutMs) => {
      calls.push({ system, input, maxTokens, timeoutMs });
      if (!values.length) throw new Error('Unexpected model call');
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next;
    }, ...extras,
  };
  return { deps, calls };
}
const pass = { pass: true, reason: '人设和事实一致。' };
const speech = (extra = {}) => ({ kind: 'chat', content: '我想和你们聊聊最近的相处。', memories: [], ...extra });
function proposal(state: AppState, supporters = [state.agents[0].id]): RoleProposal {
  return { id: 'role-1', proposerId: state.agents[0].id, holderId: state.agents[0].id,
    title: '茶话召集人', duties: '征求时间并组织自愿茶话，不指挥其他成员。', reason: '相处中愿意主动照顾交流节奏。',
    createdAt: NOW, supporterIds: supporters, status: 'pending' };
}
const event = (id: string, actor: string, target?: string): DailyEvent => ({ id, agentId: actor, targetId: target, kind: 'chat', content: id, checked: true, createdAt: NOW });

test('daily context exposes public members and own visible conversation but no other private material', () => {
  const state = members(4);
  const [a, b, c, archived] = state.agents;
  archived.archivedAt = NOW;
  b.chats.push({ id: 'secret-chat', role: 'user', content: 'OTHER_PRIVATE_CHAT', createdAt: NOW });
  b.memories.push({ id: 'secret-memory', kind: 'experience', content: 'OTHER_PRIVATE_MEMORY', source: 'secret-chat', createdAt: NOW });
  b.strategy = 'OTHER_PRIVATE_STRATEGY';
  a.chats.push({ id: 'own-private-chat', role: 'user', content: 'OWN_PRIVATE_CHAT_NOT_NEEDED', createdAt: NOW });
  state.dailyEvents = [event('public', b.id), event('inbox', b.id, a.id), event('own', a.id, b.id), event('hidden-exchange', b.id, c.id), { ...event('failed', b.id), checked: false }];
  state.membershipEvents = [{ id: 'left-source', agentId: archived.id, name: archived.name, kind: 'left', createdAt: NOW }];
  const context = dailyContext(state, a, 'new-event');
  assert.deepEqual(context.members.map(member => member.id), [a.id, b.id, c.id]);
  assert.deepEqual(context.recentEvents.map(item => item.id), ['public', 'inbox', 'own']);
  assert.equal(context.membershipEvents[0].sourceId, 'left-source');
  assert.equal(context.membershipEvents[0].kind, 'left');
  for (const sentinel of ['OTHER_PRIVATE_CHAT', 'OTHER_PRIVATE_MEMORY', 'OTHER_PRIVATE_STRATEGY', 'OWN_PRIVATE_CHAT_NOT_NEEDED', 'hidden-exchange']) assert.equal(JSON.stringify(context).includes(sentinel), false);
});

test('each daily step fairly rotates one active member and requires independent review', async () => {
  const state = members();
  state.agents[1].archivedAt = NOW;
  const scriptedRun = scripted([speech(), pass, speech(), pass, speech(), pass]);
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await dailyStep(state, scriptedRun.deps));
  assert.deepEqual(results.map(result => result.agentId), [state.agents[0].id, state.agents[2].id, state.agents[0].id]);
  assert.deepEqual(scriptedRun.calls.map(call => call.system), ['daily.system', 'daily.review', 'daily.system', 'daily.review', 'daily.system', 'daily.review']);
  assert.equal(state.dailyTurn, 3);
  assert.ok(state.dailyEvents!.every(item => item.checked));
});

test('a validated self-proposal alone grants neither a private consensus nor an appointment', async () => {
  const state = members();
  const beforeSkills = structuredClone(state.agents.map(agent => agent.skills));
  const draft = proposal(state);
  const run = scripted([speech({ kind: 'propose-role', proposal: { holderId: draft.holderId, title: draft.title, duties: draft.duties, reason: draft.reason } }), pass]);
  const result = await dailyStep(state, run.deps);
  const saved = state.roleProposals![0];
  assert.equal(saved.status, 'pending');
  assert.deepEqual(saved.supporterIds, [state.agents[0].id]);
  assert.equal(result.event.proposalId, saved.id);
  assert.equal(privateRoleConsensus(state, saved).formed, false);
  assert.equal(state.agents[0].appointment, undefined);
  assert.deepEqual(state.agents.map(agent => agent.skills), beforeSkills);
  assert.throws(() => reviewRoleProposal(state, saved.id, 'approve'), /持有人本人同意/);
});

test('independent endorsement forms private consensus and only user approval creates the formal appointment', async () => {
  const state = members();
  const saved = proposal(state);
  state.roleProposals = [saved]; state.dailyTurn = 1;
  const run = scripted([speech({ kind: 'endorse-role', proposalId: saved.id }), pass]);
  await dailyStep(state, run.deps);
  assert.deepEqual(saved.supporterIds, [state.agents[0].id, state.agents[1].id]);
  assert.equal(privateRoleConsensus(state, saved).formed, true);
  assert.equal(state.agents[0].appointment, undefined);
  reviewRoleProposal(state, saved.id, 'private', { id: 'review-private', now: NOW });
  assert.equal(saved.status, 'private');
  assert.equal(state.agents[0].appointment, undefined);
  reviewRoleProposal(state, saved.id, 'approve', { id: 'review-approve', now: NOW });
  assert.equal(saved.status, 'approved');
  assert.deepEqual(state.agents[0].appointment, { title: saved.title, duties: saved.duties, appointedAt: NOW });
  assert.equal(privateRoleConsensus(state, saved).isOfficial, true);
  const after = structuredClone(state);
  reviewRoleProposal(state, saved.id, 'approve');
  assert.deepEqual(state, after);
  assert.throws(() => reviewRoleProposal(state, saved.id, 'private'), /成员档案/);
});

test('proposing someone else never fabricates their acceptance, and an explicit independent holder endorsement is required', async () => {
  const state = members();
  const saved = proposal(state, [state.agents[0].id, state.agents[2].id]);
  saved.holderId = state.agents[1].id;
  state.roleProposals = [saved]; state.dailyTurn = 1;
  assert.equal(privateRoleConsensus(state, saved).formed, false);
  assert.throws(() => reviewRoleProposal(state, saved.id, 'private'), /持有人本人同意/);
  await dailyStep(state, scripted([speech({ kind: 'endorse-role', proposalId: saved.id }), pass]).deps);
  assert.equal(privateRoleConsensus(state, saved).formed, true);
  assert.equal(state.agents[1].appointment, undefined);
});

test('declining withdraws only the acting member endorsement, and user rejection preserves private consensus', async () => {
  const state = members();
  const saved = proposal(state, state.agents.map(agent => agent.id));
  state.roleProposals = [saved]; state.dailyTurn = 1;
  reviewRoleProposal(state, saved.id, 'reject', { id: 'rejected', now: NOW });
  assert.equal(saved.status, 'rejected');
  assert.equal(privateRoleConsensus(state, saved).formed, true);
  await dailyStep(state, scripted([speech({ kind: 'decline-role', proposalId: saved.id }), pass]).deps);
  assert.deepEqual(saved.supporterIds, [state.agents[0].id, state.agents[2].id]);
  assert.equal(privateRoleConsensus(state, saved).formed, true);
  assert.equal(state.agents[0].appointment, undefined);
});

test('archived or nonexistent supporters cannot produce consent or official approval', () => {
  const state = members();
  state.agents[1].archivedAt = NOW;
  const saved = proposal(state, [state.agents[0].id, state.agents[1].id, 'invented', state.agents[0].id]);
  state.roleProposals = [saved];
  assert.deepEqual(privateRoleConsensus(state, saved).supporterIds, [state.agents[0].id]);
  assert.equal(privateRoleConsensus(state, saved).formed, false);
  assert.throws(() => reviewRoleProposal(state, saved.id, 'approve'), /当前在庭成员/);
  saved.supporterIds.push(state.agents[2].id);
  state.agents[0].archivedAt = NOW;
  assert.equal(privateRoleConsensus(state, saved).holderActive, false);
  assert.throws(() => reviewRoleProposal(state, saved.id, 'approve'), /持有人本人同意/);
});

test('fabricated supporters, invalid references and hidden memory sources never mutate proposals or learning', async () => {
  const invalidActions = [
    speech({ kind: 'endorse-role', proposalId: 'invented-role' }),
    speech({ kind: 'propose-role', proposal: { holderId: 'nobody', title: '领袖', duties: '自称领袖', reason: '自称' } }),
    speech({ supporterIds: ['forged-supporter'] }),
    speech({ memories: [{ kind: 'relationship', content: '伪造了别人的私下支持。', source: 'other-private-chat' }] }),
  ];
  for (const action of invalidActions) {
    const state = members();
    const agents = structuredClone(state.agents);
    const run = scripted([action, action]);
    const result = await dailyStep(state, run.deps);
    assert.equal(result.event.checked, false);
    assert.equal(state.roleProposals, undefined);
    assert.deepEqual(state.agents, agents);
    assert.equal(run.calls.length, 2);
    assert.ok(run.calls.every(call => call.system === 'daily.system'));
  }
});

test('failed independent review never commits a candidate action, strategy or memory, and is bounded to two attempts', async () => {
  const state = members();
  const agents = structuredClone(state.agents);
  const candidate = speech({ revisedStrategy: '我现在随意改变人格。', memories: [{ kind: 'experience', content: '假学习', source: 'daily-generated-1' }] });
  const run = scripted([candidate, { pass: false, reason: '人物设定不一致。' }, candidate, { pass: false, reason: '仍然不一致。' }]);
  const result = await dailyStep(state, run.deps);
  assert.equal(result.event.checked, false);
  assert.match(result.message!, /未通过检查/);
  assert.equal(run.calls.length, 4);
  assert.match(String(run.calls[2].input.correction), /人物设定不一致/);
  assert.deepEqual(state.agents, agents);
  assert.equal(state.dailyTurn, 1);
});

test('approved learning updates only its actor and preserves free ability values', async () => {
  const state = members();
  state.debugOptions = { contentRulesEnabled: false };
  state.agents[0].skillPolicy = 'unrestricted'; state.agents[0].skills.communication = 100;
  const beforeOther = structuredClone(state.agents.slice(1));
  const skills = structuredClone(state.agents[0].skills);
  const run = scripted([speech({ revisedStrategy: '先听清对方顾虑，再提出属于自己的方案。', memories: [{ kind: 'relationship', content: '我主动邀请大家聊近况。', source: 'daily-generated-1' }] }), pass], { topic: '准备一次茶话会' });
  await dailyStep(state, run.deps);
  assert.equal(state.agents[0].memories.length, 2);
  assert.equal(state.agents[0].memories[0].source, state.dailyEvents![0].id);
  assert.equal(state.agents[0].strategy, '先听清对方顾虑，再提出属于自己的方案。');
  assert.deepEqual(state.agents[0].skills, skills);
  assert.deepEqual(state.agents.slice(1), beforeOther);
  assert.equal(run.calls[0].input.topic, '准备一次茶话会');
  for (const call of run.calls) assert.equal((call.input.validationPolicy as { contentRulesEnabled: boolean }).contentRulesEnabled, false);
});

test('provider outages leave the state unchanged, and absent membership avoids all calls', async () => {
  const state = members();
  const before = structuredClone(state);
  await assert.rejects(() => dailyStep(state, scripted([new PalaceError('服务暂不可用。', 503, 'PROVIDER_ERROR')]).deps), /暂不可用/);
  assert.deepEqual(state, before);
  state.agents.forEach(agent => { agent.hired = false; });
  const run = scripted([]);
  await assert.rejects(() => dailyStep(state, run.deps), /至少一位成员/);
  assert.equal(run.calls.length, 0);
});

test('daily history and default memories are retained beyond former capacity limits', async () => {
  const state = members();
  state.dailyEvents = Array.from({ length: 200 }, (_, index) => event(`old-${index}`, state.agents[0].id));
  state.roleProposals = [proposal(state)];
  state.agents[0].memories = Array.from({ length: 100 }, (_, index) => ({ id: `m-${index}`, kind: 'experience', content: `旧记忆${index}`, source: `old-${index}`, createdAt: NOW }));
  const memories = structuredClone(state.agents[0].memories);
  await dailyStep(state, scripted([speech({ memories: [{ kind: 'experience', content: '新记忆不会清除旧记忆', source: 'daily-generated-1' }] }), pass]).deps);
  assert.equal(state.dailyEvents.length, 201);
  assert.equal(state.dailyEvents[0].id, 'old-0');
  assert.deepEqual(state.agents[0].memories.slice(0, 100), memories);
  assert.equal(state.agents[0].memories.length, 101);
  assert.equal(dailyContext(state, state.agents[0], 'next').recentEvents.length, 30);
  assert.equal(state.roleProposals[0].id, 'role-1');
});

test('historical approved proposal does not claim current office after direct appointment changes', () => {
  const state = members();
  const saved = proposal(state, [state.agents[0].id, state.agents[1].id]);
  state.roleProposals = [saved];
  reviewRoleProposal(state, saved.id, 'approve');
  assert.equal(privateRoleConsensus(state, saved).isOfficial, true);
  state.agents[0].appointment!.title = '另一项新职位';
  assert.equal(privateRoleConsensus(state, saved).isOfficial, false);
  assert.equal(privateRoleConsensus(state, saved).formed, true);
});

test('solo daily steps and proposals beyond the former archive limit remain available', async () => {
  const state = members(1);
  state.roleProposals = Array.from({ length: 120 }, (_, index) => ({ ...proposal(state), id: `old-role-${index}`, title: `旧职位${index}` }));
  const proposed = { holderId: state.agents[0].id, title: '新的自荐', duties: '整理资料', reason: '愿意开始整理' };
  await dailyStep(state, scripted([speech({ kind: 'propose-role', proposal: proposed }), pass]).deps);
  assert.equal(state.dailyEvents!.length, 1); assert.equal(state.roleProposals.length, 121);
  assert.equal(state.roleProposals[0].id, 'old-role-0');
  assert.equal(privateRoleConsensus(state, state.roleProposals.at(-1)!).formed, false);
});

test('configured personal memory capacity stops additions without deleting memories or daily history', async () => {
  const state = members(1); state.settings.memoryLimit = 1;
  state.agents[0].memories.push({ id: 'kept', kind: 'experience', content: '保留', source: 'old-source', createdAt: NOW });
  await dailyStep(state, scripted([speech({ memories: [{ kind: 'experience', content: '新记忆', source: 'daily-generated-1' }] }), pass]).deps);
  assert.equal(state.agents[0].memories.length, 1); assert.equal(state.agents[0].memories[0].id, 'kept');
  assert.equal(state.dailyEvents!.length, 1);
});
