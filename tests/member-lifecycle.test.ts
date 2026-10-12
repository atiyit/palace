import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { activeMembers, archiveMember, clearAllData, DELETED_MEMBER_ID, membershipContext, permanentlyDeleteMember, restoreMember } from '../lib/member-lifecycle.ts';
import { runPendingCleanup } from '../lib/server/data-cleanup.ts';
import type { AppState, Task } from '../lib/types.ts';
import { dailyContext } from '../lib/server/daily-life.ts';
import { taskVisibility, validateTaskAction } from '../lib/server/guardrails.ts';
import { startRecruitment } from '../lib/server/recruitment.ts';

const now = '2026-10-12T12:00:00.000Z';
function fixture() {
  const state = createInitialState();
  state.agents = state.agents.slice(0, 3);
  state.agents.forEach(agent => { agent.hired = true; agent.weight = 8; });
  const [a, b, c] = state.agents;
  a.chats = [{ id: 'private-message', role: 'assistant', content: 'private words', createdAt: now, image: { status: 'ready', request: 'portrait', prompt: 'private prompt', url: '/api/portraits/chat-private-message', model: 'fixture' } }];
  a.memories = [{ id: 'memory', kind: 'experience', content: 'private memory', source: 'private-message', createdAt: now }];
  a.appointment = { title: '协调人', duties: '收集建议', appointedAt: now };
  const task: Task = { id: 'task', title: '一起写作', status: 'running', rounds: 2, round: 1, participants: [a.id, b.id, c.id], order: [a.id, b.id, c.id], cursor: 1, createdAt: now };
  state.tasks = [task];
  return state;
}

test('leaving and restoring preserve identity, memory, affection and original membership', () => {
  const state = fixture();
  const before = structuredClone(state.agents);
  const first = state.agents[0];
  archiveMember(state, first.id, now);
  assert.equal(first.archivedAt, now);
  assert.equal(activeMembers(state).length, 2);
  assert.deepEqual(state.agents.slice(1), before.slice(1));
  assert.equal(membershipContext(state).recentChanges[0].kind, 'left');
  assert.equal(state.tasks[0].cursor, 0);
  assert.equal(state.tasks[0].order[0], state.agents[1].id);
  restoreMember(state, first.id, now);
  assert.deepEqual(state.agents, before);
  assert.equal(state.membershipEvents?.[1].kind, 'returned');
  assert.equal(state.tasks[0].participants.includes(first.id), false, 'return does not silently reinsert a member into an ongoing task');
});

test('removing next speaker preserves remaining order, permits solo work and pauses empty groups', () => {
  const state = fixture();
  archiveMember(state, state.agents[1].id, now);
  assert.equal(state.tasks[0].cursor, 1);
  assert.equal(state.tasks[0].order[1], state.agents[2].id);
  archiveMember(state, state.agents[2].id, now);
  assert.equal(state.tasks[0].status, 'running');
  assert.deepEqual(state.tasks[0].participants, [state.agents[0].id]);
  archiveMember(state, state.agents[0].id, now);
  assert.equal(state.tasks[0].status, 'paused');
  assert.match(state.tasks[0].lastError || '', /没有在庭参与成员/);
  assert.equal(state.agents[0].weight, 8);
});

test('restoring a member permits more than eight members without changing her profile', () => {
  const state = createInitialState();
  state.agents.forEach(agent => { agent.hired = true; });
  const archived = structuredClone(state.agents[0]);
  archived.id = 'archived-extra'; archived.archivedAt = now;
  state.agents.push(archived);
  const before = structuredClone(archived); delete before.archivedAt;
  restoreMember(state, archived.id, now);
  assert.deepEqual(archived, before);
  assert.equal(activeMembers(state).length, 9);
  assert.equal(state.membershipEvents?.at(-1)?.kind, 'returned');
});

test('removing the final unplayed speaker advances a complete round without duplicate turns', () => {
  const state = fixture();
  state.tasks[0].cursor = 2;
  archiveMember(state, state.agents[2].id, now);
  assert.equal(state.tasks[0].round, 2);
  assert.equal(state.tasks[0].cursor, 0);
  assert.deepEqual(state.tasks[0].order, state.agents.slice(0, 2).map(agent => agent.id));
});

test('unlimited-round tasks continue after membership changes and removed speakers release pending turns', () => {
  const state = fixture(), task = state.tasks[0];
  task.rounds = 0; task.round = 9; task.cursor = 2;
  task.groupTurn = { agentId: state.agents[2].id, eventId: 'unfinished', toolCalls: 4, imageCalls: 0, corrected: false, correction: '', startedAt: now };
  archiveMember(state, state.agents[2].id, now);
  assert.equal(task.status, 'running'); assert.equal(task.round, 10); assert.equal(task.cursor, 0);
  assert.equal(task.groupTurn, undefined);
});

test('completed tasks also release legacy pending delivery when its member leaves or is deleted', () => {
  const state = fixture(), task = state.tasks[0], agent = state.agents[0];
  task.status = 'completed';
  task.deliveryProgress = { agentId: agent.id, eventId: 'unfinished-delivery', toolCalls: 4, correction: '', startedAt: now };
  task.artifacts = [{ id: 'saved-file', agentId: agent.id, eventId: 'unfinished-delivery', name: 'saved.txt', mimeType: 'text/plain', size: 1, createdAt: now, url: '/api/artifacts/saved-file' }];
  archiveMember(state, agent.id, now);
  assert.equal(task.deliveryProgress, undefined); assert.equal(task.status, 'completed');
  permanentlyDeleteMember(state, agent.id, '永久删除', now);
  assert.equal(task.artifacts.length, 1); assert.equal(task.artifacts[0].agentId, DELETED_MEMBER_ID);
});

test('an archived sender request remains history but cannot receive a new delegation acceptance', () => {
  const state = fixture();
  const [sender, recipient] = state.agents;
  state.events = [{ id: 'old-request', taskId: 'task', round: 1, agentId: sender.id, targetId: recipient.id, kind: 'request', content: '请帮忙核对', createdAt: now, checked: true }];
  archiveMember(state, sender.id, now);
  assert.equal(taskVisibility(recipient, state.tasks[0], state.events).pendingRequests.length, 0);
  assert.throws(() => validateTaskAction({ kind: 'accept', replyTo: 'old-request', content: '接受', memories: [] }, recipient, state.tasks[0], state.events), { code: 'INVALID_AGENT_ACTION' });
  assert.equal(state.events[0].content, '请帮忙核对');
});

test('a fresh recruitment batch retains complete archived members and candidates for future restoration', async () => {
  const state = fixture();
  const [member, candidate] = state.agents;
  candidate.hired = false;
  archiveMember(state, member.id, now);
  archiveMember(state, candidate.id, now);
  const before = structuredClone(state.agents.slice(0, 2));
  const fresh = structuredClone(createInitialState().agents[3]);
  fresh.name = '本次新候选';
  await startRecruitment(state, '新的日常伙伴', 1, { generate: async () => ({ candidates: [fresh] }) });
  assert.equal(state.recruitment?.applied, true);
  assert.deepEqual(state.agents.filter(agent => agent.archivedAt), before);
  restoreMember(state, member.id, now);
  restoreMember(state, candidate.id, now);
  assert.equal(state.agents.find(agent => agent.id === member.id)?.hired, true);
  assert.equal(state.agents.find(agent => agent.id === candidate.id)?.hired, false);
});

test('permanent deletion rejects missing confirmation and active members before mutations', () => {
  const state = fixture();
  const before = structuredClone(state);
  assert.throws(() => permanentlyDeleteMember(state, state.agents[0].id, ''), { code: 'CONFIRMATION_REQUIRED' });
  assert.throws(() => permanentlyDeleteMember(state, state.agents[0].id, '永久删除'), { code: 'MEMBER_NOT_ARCHIVED' });
  assert.deepEqual(state, before);
  assert.throws(() => clearAllData(state, 'yes'), { code: 'CONFIRMATION_REQUIRED' });
  assert.deepEqual(state, before);
});

test('permanent deletion removes private data, recruitment copies and role proposals while preserving team history', () => {
  const state = fixture();
  const [a, b, c] = state.agents;
  state.events = [
    { id: 'own', taskId: 'task', round: 1, agentId: a.id, kind: 'propose', content: 'deleted role speech', checked: true, createdAt: now },
    { id: 'other', taskId: 'task', round: 1, agentId: b.id, targetId: a.id, kind: 'help', content: 'other normal contribution', checked: true, createdAt: now },
  ];
  state.roleProposals = [
    { id: 'related-role', proposerId: b.id, holderId: a.id, title: '协调', duties: '协调', reason: '自发', supporterIds: [a.id, b.id], status: 'pending', createdAt: now },
    { id: 'kept-role', proposerId: b.id, holderId: c.id, title: '记录', duties: '记录', reason: '自发', supporterIds: [a.id, b.id], status: 'private', createdAt: now },
  ];
  state.recruitment = { id: 'batch', brief: 'old', count: 1, createdAt: now, updatedAt: now, applied: true, slots: [{ slot: 1, status: 'succeeded', attempts: 1, issues: [], candidate: structuredClone(a) }] };
  state.tasks[0].artifacts = [{ id: 'artifact', agentId: a.id, name: 'team-result.txt', mimeType: 'text/plain', size: 1, createdAt: now, url: '/api/artifacts/artifact' }];
  archiveMember(state, a.id, now);
  permanentlyDeleteMember(state, a.id, '永久删除', now);
  assert.equal(state.agents.some(agent => agent.id === a.id), false);
  assert.equal(state.recruitment, undefined);
  const serialized = JSON.stringify(state);
  for (const privateText of ['private words', 'private prompt', 'private memory', 'deleted role speech']) assert.equal(serialized.includes(privateText), false);
  assert.equal(state.events[0].agentId, DELETED_MEMBER_ID);
  assert.equal(state.events[0].checked, false);
  assert.equal(state.events[1].content, 'other normal contribution');
  assert.equal(state.events[1].targetId, undefined);
  assert.equal(state.roleProposals.length, 1);
  assert.deepEqual(state.roleProposals[0].supporterIds, [b.id]);
  assert.equal(state.tasks[0].artifacts?.[0].agentId, DELETED_MEMBER_ID);
  assert.equal(state.pendingCleanup?.[0].kind, 'member');
  assert.ok(state.pendingCleanup?.[0].imageIds.includes('chat-private-message'));
});

test('clear all creates an empty courtyard, resets optional settings and queues cleanup without seeding new roles', () => {
  const state = fixture();
  state.promptOverrides = { 'actor.system': 'custom' };
  state.debugOptions = { contentRulesEnabled: false };
  state.settings = { exploration: .5, drama: 1 };
  clearAllData(state, '清除所有数据', now);
  assert.deepEqual(state.agents, []);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.promptOverrides, undefined);
  assert.equal(state.debugOptions, undefined);
  assert.deepEqual(state.settings, { exploration: .2, drama: .6 });
  assert.equal(state.config.textReady, false);
  assert.equal(state.pendingCleanup?.length, 1);
  assert.equal(state.pendingCleanup?.[0].kind, 'all');
});

test('deleting a private daily recipient does not publish the surviving sender conversation to other members', () => {
  const state = fixture();
  const [recipient, sender, third] = state.agents;
  state.dailyEvents = [{ id: 'private-daily', agentId: sender.id, targetId: recipient.id, kind: 'chat', content: 'Only the two of us saw this.', createdAt: now, checked: true }];
  archiveMember(state, recipient.id, now);
  permanentlyDeleteMember(state, recipient.id, '永久删除', now);
  assert.equal(state.dailyEvents[0].targetId, DELETED_MEMBER_ID);
  assert.equal(dailyContext(state, sender, 'current').recentEvents.length, 1);
  assert.equal(dailyContext(state, third, 'current').recentEvents.length, 0);
});

function memoryBucket(keys: string[], fail = false) {
  const objects = new Set(keys);
  let shouldFail = fail;
  const bucket = {
    async list(options: { prefix: string }) { return { objects: [...objects].filter(key => key.startsWith(options.prefix)).map(key => ({ key })), truncated: false }; },
    async delete(input: string | string[]) {
      if (shouldFail) { shouldFail = false; throw new Error('simulated storage outage'); }
      for (const key of Array.isArray(input) ? input : [input]) objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

test('post-commit member cleanup removes orphan pictures, preserves archived peers and retries partial failures', async () => {
  const state = fixture();
  const [a, b] = state.agents;
  archiveMember(state, a.id, now); archiveMember(state, b.id, now);
  permanentlyDeleteMember(state, a.id, '永久删除', now);
  const { bucket, objects } = memoryBucket([`portraits/owner/${a.id}`, 'portraits/owner/chat-private-message', 'portraits/owner/chat-trimmed-old', `portraits/owner/${b.id}`, 'portraits/other/safe'], true);
  const first = await runPendingCleanup('owner', state, { BUCKET: bucket });
  assert.equal(first.pending, 1);
  assert.match(first.message || '', /重试清理/);
  assert.equal(state.agents.some(agent => agent.id === a.id), false);
  const second = await runPendingCleanup('owner', state, { BUCKET: bucket });
  assert.equal(second.pending, 0);
  assert.deepEqual([...objects].sort(), [`portraits/owner/${b.id}`, 'portraits/other/safe'].sort());
  assert.equal((await runPendingCleanup('owner', state, { BUCKET: bucket })).completed, 0);
});
