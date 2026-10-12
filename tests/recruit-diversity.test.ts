import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createInitialState } from "../lib/seeds.ts";
import type { Agent, RecruitmentBatch } from "../lib/types.ts";
import { recruitmentDiversity, recruitmentDiversityIssues } from "../lib/server/recruit-diversity.ts";
import { startRecruitment, retryRecruitment, skipRecruitmentSlot, type RecruitmentGenerationInput } from "../lib/server/recruitment.ts";

const candidate = (index: number, name: string): Agent => ({ ...structuredClone(createInitialState().agents[index]), name });
const fixture = () => { const state = createInitialState(); state.agents = []; return state; };
const batch = (id = "one"): RecruitmentBatch => ({ id, brief: "都是温和的仿生机器人，擅长研究", count: 10, slots: [], applied: false, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" });

test("parallel slots get stable, different optional angles; new batches do not repeat the same complete assignment", () => {
  const state = fixture(); const current = batch();
  const plans = Array.from({ length: 10 }, (_, index) => recruitmentDiversity(state, current, index + 1));
  for (const axis of Object.keys(plans[0].assignedVariation)) {
    assert.equal(new Set(plans.map(plan => plan.assignedVariation[axis as keyof typeof plan.assignedVariation])).size, 10);
  }
  assert.deepEqual(recruitmentDiversity(state, current, 3), plans[2]);
  assert.notDeepEqual(recruitmentDiversity(state, batch("two"), 3).assignedVariation, plans[2].assignedVariation);
  assert.equal("species" in plans[0].assignedVariation, false);
  assert.equal("age" in plans[0].assignedVariation, false);
});

test("diversity context includes archived people and successful slots, summarizes repeated details, and never shares private context", () => {
  const state = fixture();
  const first = candidate(0, "已有成员"); first.hired = true;
  first.memories = [{ id: "secret", kind: "preference", content: "private-memory-marker", source: "secret-source", createdAt: first.createdAt }];
  first.chats = [{ id: "secret-chat", role: "user", content: "private-chat-marker", createdAt: first.createdAt }];
  first.strategy = "private-strategy-marker";
  const archived = candidate(1, "回收站成员"); archived.archivedAt = first.createdAt;
  archived.traits = first.traits.slice();
  state.agents = [first, archived];
  const current = batch();
  const succeeded = candidate(2, "本批已成功");
  current.slots = [{ slot: 1, status: "succeeded", candidate: succeeded, attempts: 1, issues: [] }];
  const context = recruitmentDiversity(state, current, 2);
  assert.equal(context.totalKnownCharacters, 3);
  assert.equal(context.existingCharacters[0].name, succeeded.name);
  assert.equal(context.existingCharacters.find(person => person.name === archived.name)?.status, "archived");
  assert.ok(context.repeatedDetails.some(detail => detail.field === "traits" && detail.count === 2));
  for (const marker of ["private-memory-marker", "private-chat-marker", "private-strategy-marker"]) assert.equal(JSON.stringify(context).includes(marker), false);
  assert.equal(context.existingCharacters[0].strongestSkills.length, 3);
  assert.equal(context.existingCharacters[0].weakestSkills.length, 3);
});

test("context is bounded but duplicate detection still compares every known dossier", () => {
  const state = fixture();
  state.agents = Array.from({ length: 40 }, (_, index) => ({ ...candidate(index % 8, `角色${index}`), id: `a-${index}` }));
  const context = recruitmentDiversity(state, batch(), 1);
  assert.equal(context.totalKnownCharacters, 40);
  assert.equal(context.existingCharacters.length, 24);
  assert.ok(context.repeatedDetails.length <= 16);
  assert.ok(recruitmentDiversityIssues(candidate(0, "换名复刻"), state.agents, "普通研究角色").length > 0);
});

test("only a copied multidimensional dossier fails; shared user direction, looks or strengths remain valid", () => {
  const known = candidate(0, "前人");
  const copy = { ...structuredClone(known), name: "只是改名" };
  const issues = recruitmentDiversityIssues(copy, [known], "都需要研究能力与温和性格");
  assert.ok(issues.length > 0);
  assert.ok(issues.every(issue => issue.path.startsWith("candidates.0.") && issue.message.includes(known.name)));
  const distinct = candidate(1, "同方向新角色");
  distinct.species = structuredClone(known.species); distinct.appearance = known.appearance;
  distinct.skills = { ...known.skills }; distinct.traits = known.traits.slice();
  assert.deepEqual(recruitmentDiversityIssues(distinct, [known], "同一个型号，同样外观、性格方向和技能分配"), []);
  assert.deepEqual(recruitmentDiversityIssues(copy, [known], "请生成完全相同的克隆角色，只有名字不同"), []);
  assert.ok(recruitmentDiversityIssues(copy, [known], "不要生成一模一样的角色").length > 0);
  const namedKnown = structuredClone(known);
  const namedCopy = structuredClone(copy);
  for (const key of Object.keys(namedKnown.profile) as (keyof typeof namedKnown.profile)[]) {
    const original = namedKnown.profile[key];
    if (typeof original === "string") {
      Reflect.set(namedKnown.profile, key, `${known.name}：${original}`);
      Reflect.set(namedCopy.profile, key, `${copy.name}：${original}`);
    }
  }
  assert.ok(recruitmentDiversityIssues(namedCopy, [namedKnown], "同方向但不同人物").length > 0);
});

test("explicit whole-dossier reuse is allowed without confusing shared looks or a negated copying request", () => {
  const known = candidate(0, "清禾"); const copy = { ...structuredClone(known), name: "第二位角色" };
  for (const brief of [
    "除姓名外，所有设定都与清禾保持一致，生成第二位角色。",
    "名字不同，其余人物设定沿用清禾。",
    "请沿用清禾的整套人物设定，仅更换名字。",
    "复制清禾的全部档案，然后取一个新名字。",
    "除名字之外设定一律不变。",
    "只换名字，其他设定保持一致。",
    "Please reuse the entire character dossier and give her a new name.",
  ]) assert.deepEqual(recruitmentDiversityIssues(copy, [known], brief), [], brief);
  for (const brief of [
    "不要让所有设定保持一致，大方向一样但细节不能趋同。",
    "所有设定都不要与清禾保持一致。",
    "不需要沿用清禾的整套人物设定，只要同样擅长规划。",
    "请招募外观完全相同的角色，性格和经历要各自独立。",
    "角色都是克隆人，但每个人有自己的生活经历。",
    "同一个型号、相同研究能力，其他细节自由。",
    "Do not reuse the entire character dossier. Keep only her profession.",
  ]) assert.ok(recruitmentDiversityIssues(copy, [known], brief).length > 0, brief);
});

test("two in-flight dossiers cannot both copy the same new profile, and manual retry keeps the successful dossier", async () => {
  const state = fixture(); let count = 0; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const requests: RecruitmentGenerationInput[] = [];
  await startRecruitment(state, "同一大方向，细节保持不同", 2, { generate: async input => {
    requests.push(input); count++; if (count === 2) release();
    await barrier;
    return { candidates: [candidate(0, `候选${input.slot}`)] };
  } });
  assert.equal(count, 2);
  assert.notDeepEqual(requests[0].diversity.assignedVariation, requests[1].diversity.assignedVariation);
  const current = state.recruitment!;
  const passed = current.slots.find(slot => slot.status === "succeeded")!;
  const failed = current.slots.find(slot => slot.errorCode === "RECRUITMENT_SIMILAR")!;
  assert.ok(failed); assert.ok(passed); assert.equal(current.applied, false);
  const saved = structuredClone(passed.candidate);
  await retryRecruitment(state, current.id, failed.slot, { generate: async input => {
    count++;
    assert.equal(input.previousErrorCode, "RECRUITMENT_SIMILAR");
    assert.ok(input.diversity.existingCharacters.some(person => person.name === passed.candidate!.name));
    assert.deepEqual(input.diversity.assignedVariation, requests.find(request => request.slot === failed.slot)!.diversity.assignedVariation);
    return { candidates: [candidate(1, "重试后有不同经历")] };
  } });
  assert.equal(count, 3); assert.equal(current.applied, true); assert.deepEqual(passed.candidate, saved);
});

test("subsequent recruitment avoids retained profiles and observes the debug content-rule switch", async () => {
  const state = fixture();
  await startRecruitment(state, "温和但有独立细节", 1, { generate: async () => ({ candidates: [candidate(0, "第一位")] }) });
  state.agents[0].hired = true;
  await startRecruitment(state, "温和但有独立细节", 1, { generate: async input => {
    assert.ok(input.diversity.existingCharacters.some(person => person.name === "第一位"));
    return { candidates: [candidate(0, "下一次改名复刻")] };
  } });
  assert.equal(state.recruitment!.slots[0].errorCode, "RECRUITMENT_SIMILAR");
  state.debugOptions = { contentRulesEnabled: false };
  await retryRecruitment(state, state.recruitment!.id, 1, { generate: async input => {
    assert.ok(input.diversity.existingCharacters.length > 0);
    return { candidates: [candidate(0, "调试允许的同设定")] };
  } });
  assert.equal(state.recruitment!.applied, true);
  assert.equal(state.agents.length, 2);
});

test("deleting a failed slot applies successful files once, preserves requested count and members, and never regenerates", async () => {
  const state = fixture(); const member = candidate(2, "保留成员"); member.hired = true; state.agents.push(member);
  let calls = 0;
  await startRecruitment(state, "两个独立人物", 2, { generate: async input => {
    calls++; return input.slot === 1 ? { candidates: [candidate(0, "成功人物")] } : {};
  } });
  const current = state.recruitment!; const success = structuredClone(current.slots[0].candidate);
  assert.equal(current.applied, false);
  const message = skipRecruitmentSlot(state, current.id, 2);
  assert.match(message, /1份档案/); assert.equal(current.applied, true); assert.equal(current.count, 2);
  assert.equal(current.slots[1].status, "skipped"); assert.equal(current.slots[1].attempts, 1);
  assert.equal(state.agents.length, 2); assert.strictEqual(state.agents[0], member);
  assert.deepEqual(state.agents[1], success);
  const saved = structuredClone(state);
  skipRecruitmentSlot(state, current.id, 2);
  await retryRecruitment(state, current.id, undefined, { generate: async () => { calls++; return {}; } });
  assert.equal(calls, 2); assert.deepEqual(state, saved);
});

test("skipped slots stay skipped during retry-all while successful slots and prior candidates are kept until settlement", async () => {
  const state = fixture(); const old = candidate(3, "旧候选"); state.agents.push(old);
  await startRecruitment(state, "三个不同人物", 3, { generate: async input => {
    await setImmediate(); return input.slot === 1 ? { candidates: [candidate(0, "成功人物")] } : {};
  } });
  const current = state.recruitment!;
  skipRecruitmentSlot(state, current.id, 2);
  assert.equal(current.applied, false); assert.strictEqual(state.agents[0], old);
  const calls: number[] = [];
  await retryRecruitment(state, current.id, undefined, { generate: async input => {
    calls.push(input.slot); return { candidates: [candidate(1, "重试人物")] };
  } });
  assert.deepEqual(calls, [3]); assert.equal(current.applied, true); assert.equal(current.count, 3);
  assert.equal(current.slots[1].status, "skipped"); assert.equal(current.slots[0].attempts, 1);
  assert.deepEqual(state.agents.map(agent => agent.name), ["成功人物", "重试人物"]);
});

test("all failures can be removed without erasing prior candidates, and success/pending/expired slots cannot be deleted", async () => {
  const state = fixture(); const old = candidate(0, "原有候选"); state.agents.push(old);
  await startRecruitment(state, "两位角色", 2, { generate: async () => ({}) });
  const current = state.recruitment!;
  skipRecruitmentSlot(state, current.id, 1);
  skipRecruitmentSlot(state, current.id, 2);
  assert.equal(current.applied, true); assert.deepEqual(state.agents, [old]);
  assert.throws(() => skipRecruitmentSlot(state, "old-batch", 1), { code: "RECRUITMENT_EXPIRED" });
  assert.throws(() => skipRecruitmentSlot(state, current.id, 0));
  current.slots[0].status = "pending";
  assert.throws(() => skipRecruitmentSlot(state, current.id, 1), { code: "RECRUITMENT_SLOT_NOT_FAILED" });
  current.slots[0].status = "succeeded"; current.slots[0].candidate = old;
  assert.throws(() => skipRecruitmentSlot(state, current.id, 1), { code: "RECRUITMENT_SLOT_NOT_FAILED" });
});
