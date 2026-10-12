import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialState } from '../lib/seeds.ts';
import type { Task } from '../lib/types.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
const { DailyLife } = await vite.ssrLoadModule(join(project, 'components/daily-life.tsx'));
const { TaskGroup } = await vite.ssrLoadModule(join(project, 'components/task-group.tsx'));
const { RuntimeLimits } = await vite.ssrLoadModule(join(project, 'components/runtime-limits.tsx'));
const { RecruitmentPanel } = await vite.ssrLoadModule(join(project, 'components/recruitment-panel.tsx'));
after(async () => { await vite.close(); });
const noop = () => {};
const ok = async () => true;
const button = (html: string, label: string) => {
  const match = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(item => item[2].replace(/<[^>]+>/g, '').trim() === label);
  assert.ok(match, `missing button ${label}`);
  return { disabled: /\bdisabled(?:=|\s|$)/.test(match[1]) };
};
const input = (html: string, id: string) => {
  const match = [...html.matchAll(/<input\b[^>]*>/g)].find(item => item[0].includes(`id="${id}"`));
  assert.ok(match, `missing input ${id}`);
  return match[0];
};
const fixture = () => {
  const state = createInitialState(); state.agents = state.agents.slice(0, 1); state.agents[0].hired = true; state.config.textReady = true;
  return state;
};

test('one member can start daily life and the numeric step control supports zero without a fixed maximum', () => {
  const html = renderToStaticMarkup(createElement(DailyLife, { state: fixture(), busy: false, progress: null, pausing: false, onRun: noop, onPause: noop, onAgent: noop, onReview: ok }));
  assert.equal(button(html, '开始相处').disabled, false);
  assert.equal(button(html, '交流一步').disabled, false);
  const field = input(html, 'daily-steps');
  assert.match(field, /type="number"/); assert.match(field, /min="0"/); assert.doesNotMatch(field, /\smax=/);
  assert.match(html, /0 = 不限/); assert.doesNotMatch(html, /至少需要两位|离开此页面.*暂停/);
});

test('ongoing unlimited daily life keeps its pause control active while write controls are disabled', () => {
  const html = renderToStaticMarkup(createElement(DailyLife, { state: fixture(), busy: true, progress: { done: 14, total: 0 }, pausing: false, onRun: noop, onPause: noop, onAgent: noop, onReview: ok }));
  assert.equal(button(html, '交流一步').disabled, true);
  assert.equal(button(html, '暂停交流').disabled, false);
  assert.match(html, /已完成 14 · 不限 步/);
});

test('single-member continuous task renders useful round progress and allows stopping an active run', () => {
  const state = fixture();
  const task: Task = { id: 'solo-task', title: '独立研究', status: 'running', rounds: 0, round: 8, participants: [state.agents[0].id], order: [state.agents[0].id], cursor: 0, createdAt: state.updatedAt, mode: 'group' };
  const props = { task, state, busy: true, running: true, pausing: false, onPause: noop, onRun: noop, onFinish: noop, onAgent: noop, onAdopt: noop, onSend: ok, onContinue: ok };
  const running = renderToStaticMarkup(createElement(TaskGroup, props));
  assert.match(running, /第 8 轮 · 持续共议/);
  assert.equal(button(running, '暂停').disabled, false);
  assert.equal(button(running, '结束共议').disabled, false);
  assert.equal(button(running, '发送到群聊').disabled, true);
  const paused = renderToStaticMarkup(createElement(TaskGroup, { ...props, busy: false, running: false }));
  assert.equal(button(paused, '继续本轮').disabled, false);
  const field = input(paused, 'tg-rounds-solo-task');
  assert.match(field, /min="0"/); assert.doesNotMatch(field, /\smax=/);
});

test('all four runtime limits default to unlimited and retain caller-saved finite values', () => {
  const state = fixture();
  const empty = renderToStaticMarkup(createElement(RuntimeLimits, { settings: state.settings, busy: false, onSave: ok }));
  for (const key of ['memoryLimit', 'groupToolLimit', 'groupImageLimit', 'groupArtifactLimit']) {
    const field = input(empty, `limit-${key}`); assert.match(field, /value="0"/); assert.match(field, /min="0"/); assert.doesNotMatch(field, /\smax=/);
  }
  const finite = renderToStaticMarkup(createElement(RuntimeLimits, { settings: { ...state.settings, memoryLimit: 800, groupToolLimit: 25, groupImageLimit: 7, groupArtifactLimit: 120 }, busy: true, onSave: ok }));
  assert.match(input(finite, 'limit-memoryLimit'), /value="800"/);
  assert.equal(button(finite, '保存额度').disabled, true);
});

test('random draft and direct recruitment are separate enabled actions when the direction is empty', () => {
  const html = renderToStaticMarkup(createElement(RecruitmentPanel, { brief: '', count: 4, busy: null, textReady: true, activeSlots: [], onBriefChange: noop, onCountChange: noop, onRecruit: ok, onRandomBrief: ok, onRandomRecruit: ok, onRetry: ok, onSkip: ok }));
  assert.equal(button(html, '随机人物设定').disabled, false);
  assert.equal(button(html, '随机招募 · 4 份').disabled, false);
  assert.equal(button(html, '开始寻访 · 4 份').disabled, true);
});
