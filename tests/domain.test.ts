import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedRelationship, applyFeedback, recommendationProbabilities, validateSettings, weightedSample } from '../lib/domain.ts';
import { createInitialState } from '../lib/seeds.ts';
import type { SocialEvent } from '../lib/types.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} differs from ${expected}`);
const social = (overrides: Partial<SocialEvent> = {}): SocialEvent => ({
  id: 'request-1', taskId: 'task-1', round: 1, agentId: 'jade', targetId: 'mist',
  kind: 'request', content: '可以帮我核验资料吗？', createdAt: '2026-10-12T04:00:00.000Z', checked: true,
  ...overrides,
});

test('initial recruitment has eight distinct adult personas, equal skill budgets, and no assigned leader', () => {
  const state = createInitialState();
  assert.equal(state.agents.length, 8);
  assert.equal(new Set(state.agents.map(a => a.id)).size, 8);
  assert.equal(new Set(state.agents.map(a => a.voice)).size, 8);
  assert.deepEqual(state.relationships, []);
  assert.deepEqual(state.events, []);
  for (const agent of state.agents) {
    assert.ok(agent.age >= 24 && agent.age <= 34);
    assert.match(agent.appearance, /adult woman/);
    assert.equal(Object.values(agent.skills).reduce((sum, score) => sum + score, 0), 960);
    assert.ok(Object.values(agent.skills).every(score => score >= 15 && score <= 95));
    assert.equal(agent.hired, false);
    assert.equal(agent.liked, false);
    assert.equal(agent.weight, 1);
    assert.deepEqual(agent.evidence, {});
    assert.deepEqual(agent.memories, []);
    assert.deepEqual(agent.chats, []);
    assert.ok(agent.boundaries.length >= 3);
    assert.ok(agent.strategy && agent.voice && agent.approach);
    assert.equal(Object.hasOwn(agent, 'leader'), false);
    assert.equal(Object.hasOwn(agent, 'rank'), false);
    assert.doesNotMatch(agent.title, /领袖|女王|皇后/);
  }
  assert.equal(state.config.model, 'claude-opus-4-6');
  assert.equal(state.config.imageModel, 'nai-diffusion-5-full');
});

test('a fresh state does not share mutable personality or memory data with another state', () => {
  const first = createInitialState();
  first.agents[0].skills.planning = 0;
  first.agents[0].boundaries.push('A new local boundary');
  first.agents[0].memories.push({ id: 'm1', kind: 'preference', content: 'Concise answers', source: 'user', createdAt: first.updatedAt });
  const second = createInitialState();
  assert.equal(second.agents[0].skills.planning, 90);
  assert.equal(second.agents[0].boundaries.length, 3);
  assert.equal(second.agents[0].memories.length, 0);
});

test('equal initial weights give equal exposure and normalized probabilities', () => {
  const agents = createInitialState().agents;
  const probabilities = recommendationProbabilities(agents);
  for (const probability of Object.values(probabilities)) near(probability, 1 / agents.length);
  near(Object.values(probabilities).reduce((sum, probability) => sum + probability, 0), 1);
  assert.deepEqual(recommendationProbabilities([]), {});
});

test('user preference increases exposure while every other agent keeps an exploration floor', () => {
  const agents = createInitialState().agents;
  const before = recommendationProbabilities(agents);
  applyFeedback(agents[0], 'like');
  const afterLike = recommendationProbabilities(agents);
  assert.ok(afterLike[agents[0].id] > before[agents[0].id]);
  agents[0].weight = 1_000_000;
  const probabilities = recommendationProbabilities(agents, .2);
  for (const agent of agents.slice(1)) assert.ok(probabilities[agent.id] >= .2 / agents.length);
  near(Object.values(probabilities).reduce((sum, probability) => sum + probability, 0), 1);
});

test('sampling without replacement never duplicates agents or mutates the pool', () => {
  const agents = createInitialState().agents;
  const ids = agents.map(agent => agent.id);
  const sample = weightedSample(agents, 100, .2, () => 0);
  assert.equal(sample.length, agents.length);
  assert.equal(new Set(sample.map(agent => agent.id)).size, agents.length);
  assert.deepEqual(agents.map(agent => agent.id), ids);
  assert.deepEqual(weightedSample(agents, 0), []);
  assert.deepEqual(weightedSample([], 5), []);
  assert.equal(weightedSample(agents, 1, .2, () => .999999)[0].id, agents.at(-1)?.id);
});

test('undoing a like restores its contribution without removing hiring or chat feedback', () => {
  const agent = createInitialState().agents[0];
  applyFeedback(agent, 'hire');
  applyFeedback(agent, 'chat');
  const baseline = agent.weight;
  applyFeedback(agent, 'like');
  assert.equal(agent.liked, true);
  assert.equal(agent.weight, baseline + 3);
  applyFeedback(agent, 'like');
  assert.equal(agent.liked, false);
  assert.equal(agent.weight, baseline);
  applyFeedback(agent, 'hire');
  assert.equal(agent.weight, baseline, 'hiring an already hired agent must not add a second reward');
});

test('only the first three user turns per local day can boost exposure', () => {
  const agent = createInitialState().agents[0];
  const now = new Date().toISOString();
  agent.chats.push({ id: 'assistant-only', role: 'assistant', content: '你好', createdAt: now });
  for (let index = 0; index < 6; index++) {
    applyFeedback(agent, 'chat');
    agent.chats.push({ id: `user-${index}`, role: 'user', content: `问题 ${index}`, createdAt: now });
  }
  assert.equal(agent.weight, 4);
  assert.equal(agent.chatBoost, 3);
});

test('a request, refusal, or unrelated reply cannot create a delegation relationship', () => {
  const request = social();
  assert.equal(acceptedRelationship(request, []), null);
  assert.equal(acceptedRelationship(social({ id: 'refusal', kind: 'refuse', agentId: 'mist', targetId: 'jade', replyTo: request.id }), [request]), null);
  assert.equal(acceptedRelationship(social({ id: 'help', kind: 'help', agentId: 'mist', targetId: 'jade', replyTo: request.id }), [request]), null);
  assert.equal(acceptedRelationship(social({ id: 'accept', kind: 'accept', agentId: 'mist', targetId: 'jade' }), [request]), null);
  assert.equal(acceptedRelationship(social({ id: 'accept', kind: 'accept', agentId: 'pearl', replyTo: request.id }), [request]), null);
});

test('delegation requires explicit acceptance of a request addressed to that agent in the same task', () => {
  const request = social();
  const acceptance = social({ id: 'acceptance-1', kind: 'accept', agentId: 'mist', targetId: 'jade', replyTo: request.id });
  const relationship = acceptedRelationship(acceptance, [request]);
  assert.ok(relationship);
  assert.equal(relationship.from, 'jade');
  assert.equal(relationship.to, 'mist');
  assert.equal(relationship.taskId, 'task-1');
  assert.equal(relationship.kind, 'delegation');
  assert.equal(relationship.eventId, acceptance.id);
  assert.equal(acceptedRelationship({ ...acceptance, taskId: 'task-2' }, [request]), null);
  assert.equal(acceptedRelationship({ ...acceptance, replyTo: 'invented-request' }, [request]), null);
  assert.equal(acceptedRelationship({ ...acceptance, agentId: 'jade' }, [{ ...request, targetId: 'jade' }]), null);
});

test('settings preserve valid values and reject non-finite input', () => {
  const current = { exploration: .2, drama: .6 };
  assert.deepEqual(validateSettings({ exploration: Number.NaN, drama: Number.POSITIVE_INFINITY }, current), current);
  assert.deepEqual(validateSettings({ exploration: 0, drama: 2 }, current), { exploration: .05, drama: 1 });
  assert.deepEqual(validateSettings({ exploration: .9, drama: -1 }, current), { exploration: .5, drama: 0 });
});
