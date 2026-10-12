import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredLimit, hasPersonalMemoryCapacity, personalMemoryCount } from '../lib/memory-capacity.ts';
import type { Memory } from '../lib/types.ts';

test('reserved group summaries do not consume personal capacity, but extra model memories referencing them do', () => {
  const memory = (source: string, index: number): Memory => ({ id: String(index), source, kind: 'experience', content: 'An actual observation', createdAt: new Date().toISOString() });
  const memories = Array.from({ length: 50 }, (_, i) => memory(`message-${i}`, i));
  memories.push(...Array.from({ length: 50 }, (_, i) => memory(`task-group:${i}`, i + 50)));
  assert.equal(personalMemoryCount({ memories }), 50);
  memories.push(memory('task-group:1', 101));
  assert.equal(personalMemoryCount({ memories }), 51);
  memories[50].source = '用户编辑';
  assert.equal(personalMemoryCount({ memories }), 52);
});

test('ordinary memory defaults to unlimited and an optional finite cap never removes existing records', () => {
  const memories: Memory[] = Array.from({ length: 120 }, (_, index) => ({ id: String(index), source: `message-${index}`, kind: 'experience', content: '记忆', createdAt: '2026-10-13' }));
  const agent = { memories };
  assert.equal(hasPersonalMemoryCapacity(agent), true); assert.equal(hasPersonalMemoryCapacity(agent, 0), true);
  assert.equal(hasPersonalMemoryCapacity(agent, 121), true); assert.equal(hasPersonalMemoryCapacity(agent, 120), false);
  assert.equal(hasPersonalMemoryCapacity(agent, 10), false); assert.equal(memories.length, 120);
  for (const invalid of [-1, 1.2, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '20']) assert.equal(configuredLimit(invalid), 0);
});
