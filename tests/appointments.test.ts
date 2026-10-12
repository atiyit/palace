import test from 'node:test';
import assert from 'node:assert/strict';
import { appointmentContext, removeAppointment, setAppointment } from '../lib/appointments.ts';
import { createInitialState } from '../lib/seeds.ts';
import { ownContext } from '../lib/server/guardrails.ts';
import type { Agent } from '../lib/types.ts';

const metadata = { id: 'appointment-1', now: '2026-10-12T09:00:00.000Z' };
const member = () => { const agent = createInitialState().agents[0]; agent.hired = true; return agent; };
const persistentIdentity = (agent: Agent) => ({
  name: agent.name, age: agent.age, title: agent.title, bio: agent.bio, traits: agent.traits,
  values: agent.values, boundaries: agent.boundaries, voice: agent.voice, approach: agent.approach,
  skills: agent.skills, evidence: agent.evidence, strategy: agent.strategy,
  weight: agent.weight, liked: agent.liked, chatBoost: agent.chatBoost, chats: agent.chats,
});

test('only recruited members can receive or lose appointments, and invalid calls do not mutate them', () => {
  const candidate = createInitialState().agents[0];
  const before = structuredClone(candidate);
  assert.throws(() => setAppointment(candidate, { title: '议事协调人' }, metadata));
  assert.throws(() => removeAppointment(candidate, metadata));
  assert.deepEqual(candidate, before);
  assert.equal(appointmentContext(candidate), null);
});

test('appointment validation rejects missing or overlong names and overlong duties before writing state', () => {
  const agent = member();
  const before = structuredClone(agent);
  for (const input of [{ title: '' }, { title: '  ' }, { title: '职'.repeat(31) }, { title: '协调人', duties: '责'.repeat(601) }]) {
    assert.throws(() => setAppointment(agent, input, metadata));
    assert.deepEqual(agent, before);
  }
  setAppointment(agent, { title: ` ${'职'.repeat(30)} `, duties: ` ${'责'.repeat(600)} ` }, metadata);
  assert.equal(agent.appointment?.title.length, 30);
  assert.equal(agent.appointment?.duties.length, 600);
});

test('user appointment leaves professional identity, ability, attention and social relationships unchanged', () => {
  const state = createInitialState();
  const agent = state.agents[0];
  agent.hired = true;
  const identity = structuredClone(persistentIdentity(agent));
  const relationships = structuredClone(state.relationships);
  setAppointment(agent, { title: '  议事协调人  ', duties: '  收集各人的意见，保留分歧。  ' }, metadata);
  assert.deepEqual(agent.appointment, { title: '议事协调人', duties: '收集各人的意见，保留分歧。', appointedAt: metadata.now });
  assert.deepEqual(persistentIdentity(agent), identity);
  assert.deepEqual(state.relationships, relationships);
  assert.equal(agent.memories.length, 1);
  assert.equal(agent.memories[0].id, metadata.id);
  assert.equal(agent.memories[0].source, `user-appointment:${metadata.id}`);
  assert.equal(agent.memories[0].createdAt, metadata.now);
});

test('current appointment replaces historical titles and exposes no private data or mutable reference', () => {
  const agent = member();
  agent.chats.push({ id: 'private-chat', role: 'user', content: 'PRIVATE_CHAT_SENTINEL', createdAt: metadata.now });
  setAppointment(agent, { title: '旧职务', duties: '原先职责' }, metadata);
  const changed = { id: 'appointment-2', now: '2026-10-12T10:00:00.000Z' };
  setAppointment(agent, { title: '新职务', duties: '修订职责' }, changed);
  const publicContext = appointmentContext(agent)!;
  assert.deepEqual(publicContext, { title: '新职务', duties: '修订职责', appointedAt: changed.now });
  assert.deepEqual(Object.keys(publicContext).sort(), ['title', 'duties', 'appointedAt'].sort());
  assert.equal(JSON.stringify(publicContext).includes('PRIVATE_CHAT_SENTINEL'), false);
  publicContext.title = '不能通过公开对象改名';
  assert.equal(agent.appointment?.title, '新职务');
  assert.equal(ownContext(agent, '旧职务').appointment?.title, '新职务');
  assert.ok(agent.memories.some(memory => memory.content.includes('旧职务')), 'history should be retained as history');
});

test('removal and replacement remain authoritative even when long-term memory has reached its cap', () => {
  const agent = member();
  setAppointment(agent, { title: '协调人' }, metadata);
  agent.memories = Array.from({ length: 100 }, (_, index) => ({
    id: `memory-${index}`, kind: 'experience' as const, content: index === 0 ? '历史上曾被任命为协调人' : `经历 ${index}`,
    source: `source-${index}`, createdAt: metadata.now,
  }));
  const memories = structuredClone(agent.memories);
  setAppointment(agent, { title: '新协调人' }, { ...metadata, id: 'appointment-2' });
  assert.equal(ownContext(agent, '协调人').appointment?.title, '新协调人');
  removeAppointment(agent, { ...metadata, id: 'appointment-3' });
  assert.equal(agent.appointment, undefined);
  assert.equal(ownContext(agent, '协调人').appointment, null);
  assert.deepEqual(agent.memories, memories);
});

test('identical appointment updates and repeated removal are idempotent', () => {
  const agent = member();
  setAppointment(agent, { title: '协调人' }, metadata);
  const first = structuredClone(agent);
  setAppointment(agent, { title: ' 协调人 ', duties: ' ' }, { id: 'appointment-repeat', now: '2026-10-12T12:00:00.000Z' });
  assert.deepEqual(agent, first);
  removeAppointment(agent, { id: 'appointment-remove', now: '2026-10-12T13:00:00.000Z' });
  const removed = structuredClone(agent);
  removeAppointment(agent, { id: 'appointment-remove-repeat', now: '2026-10-12T14:00:00.000Z' });
  assert.deepEqual(agent, removed);
  assert.equal(agent.memories.length, 2);
  assert.equal(appointmentContext(agent), null);
});
