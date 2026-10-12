import test from 'node:test';
import assert from 'node:assert/strict';
import { personalMemoryCount } from '../lib/memory-capacity.ts';
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
