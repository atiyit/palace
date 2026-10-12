import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createInitialState } from "../lib/seeds.ts";
import { startRecruitment, retryRecruitment, recruitmentCount, recruitmentFailure, type RecruitmentGenerationInput } from "../lib/server/recruitment.ts";
import { PalaceError } from "../lib/server/errors.ts";
import { parseModelObject } from "../lib/server/model-json.ts";
import { upgradeAppState } from "../lib/character-profile.ts";

// These tests exercise the queue and validation, so each fixture needs a genuinely distinct dossier.
const person = (name: string) => {
  const candidate = structuredClone(createInitialState().agents[0]);
  candidate.name = name;
  const motif = [...name].reduce((value, character) => Math.imul(value ^ character.codePointAt(0)!, 16777619) >>> 0, 2166136261).toString(36);
  candidate.profile = Object.fromEntries(Object.entries(candidate.profile).map(([key, value]) => [key,
    Array.isArray(value) ? value.map((_, index) => `${name}记录的${motif}${key}第${index}件特别习惯与偏好。`.repeat(3)) : `${name}记录的${motif}${key}专属经历与行为细节。`.repeat(8),
  ])) as unknown as typeof candidate.profile;
  return candidate;
};
const response = (slot: number) => ({ candidates: [person(`新候选${slot}`)] });

test("content-rule mode applies to each explicit generation while saved unrestricted characters retain their allocation", async () => {
  const state = createInitialState(); state.debugOptions = { contentRulesEnabled: false };
  const free = person("自由配分角色"); free.age = 18; free.bio = "简述";
  free.skills = Object.fromEntries(Object.keys(free.skills).map(key => [key, 100])) as typeof free.skills;
  await startRecruitment(state, "两位不同角色", 2, { generate: async input => input.slot === 1 ? { candidates: [free] } : {} });
  assert.equal(state.recruitment!.slots[0].status, "succeeded");
  assert.equal(state.recruitment!.slots[0].candidate!.skillPolicy, "unrestricted");
  const kept = structuredClone(state.recruitment!.slots[0].candidate!);
  const saved = upgradeAppState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(saved.recruitment!.slots[0].candidate, kept);
  saved.debugOptions = { contentRulesEnabled: true }; upgradeAppState(saved);
  await retryRecruitment(saved, saved.recruitment!.id, 2, { generate: async input => response(input.slot) });
  assert.equal(saved.recruitment!.applied, true);
  assert.deepEqual(saved.agents[0], kept);
  assert.equal(saved.agents[1].skillPolicy, "balanced");
  assert.equal(Object.values(saved.agents[1].skills).reduce((sum, value) => sum + value, 0), 960);
  for (const enabled of [false, true]) {
    saved.debugOptions.contentRulesEnabled = enabled;
    upgradeAppState(saved);
    assert.deepEqual(saved.agents[0], kept);
    assert.deepEqual(saved.recruitment!.slots[0].candidate, kept);
  }
});

test("recruitment uses current content rules on manual retry but never relaxes malformed fields", async () => {
  const state = createInitialState();
  const concise = { ...person("简练人物"), age: 10001, bio: "简述" };
  await startRecruitment(state, "一位角色", 1, { generate: async () => ({ candidates: [concise] }) });
  assert.equal(state.recruitment!.slots[0].status, "failed");
  state.debugOptions = { contentRulesEnabled: false };
  await retryRecruitment(state, state.recruitment!.id, 1, { generate: async () => ({ candidates: [{ ...concise, skills: { ...concise.skills, research: "100" } }] }) });
  assert.equal(state.recruitment!.slots[0].status, "failed");
  assert.ok(state.recruitment!.slots[0].issues.some(issue => issue.path === "candidates.0.skills.research"));
  await retryRecruitment(state, state.recruitment!.id, 1, { generate: async () => ({ candidates: [concise] }) });
  assert.equal(state.recruitment!.slots[0].status, "succeeded"); assert.equal(state.recruitment!.slots[0].attempts, 3);
  assert.equal(state.agents[0].age, 10001); assert.equal(state.agents[0].bio, "简述");
});

test("recruitment accepts one and ten candidates with two workers, retaining existing members", async () => {
  assert.equal(recruitmentCount(), 3);
  for (const invalid of [0, 11, -1, 1.5, "3", null, NaN]) assert.throws(() => recruitmentCount(invalid));
  for (const count of [1, 10]) {
    const state = createInitialState();
    const member = state.agents[0]; member.hired = true;
    const original = structuredClone(member);
    let active = 0; let peak = 0; let calls = 0;
    await startRecruitment(state, "保持不同人格", count, { generate: async input => {
      calls++; active++; peak = Math.max(peak, active); await setImmediate(); active--; return response(input.slot);
    } });
    assert.equal(calls, count); assert.ok(peak <= 2);
    assert.equal(state.recruitment?.count, count); assert.equal(state.recruitment?.applied, true);
    assert.equal(state.agents.length, count + 1); assert.strictEqual(state.agents[0], member);
    assert.deepEqual(member, original);
    assert.ok(state.recruitment!.slots.every(slot => slot.status === "succeeded" && slot.attempts === 1));
  }
});

test("a bad field is shown once without automatic retries and partial success is preserved", async () => {
  const state = createInitialState(); const original = structuredClone(state.agents);
  const calls: number[] = [];
  const message = await startRecruitment(state, "三位不同角色", 3, { generate: async input => {
    calls.push(input.slot);
    return input.slot === 2 ? { candidates: [{ ...person("字段错误角色"), bio: "太短" }] } : response(input.slot);
  } });
  assert.deepEqual(calls.sort(), [1, 2, 3]); assert.deepEqual(state.agents, original);
  assert.equal(state.recruitment?.applied, false); assert.match(message, /2\/3/);
  const failed = state.recruitment!.slots[1];
  assert.equal(failed.status, "failed"); assert.equal(failed.attempts, 1);
  assert.ok(failed.issues.some(issue => issue.path === "candidates.0.bio" && issue.message.includes("100")));
  assert.ok(state.recruitment!.slots[0].candidate); assert.ok(state.recruitment!.slots[2].candidate);
});

test("explicit single-slot retry preserves successes, applies the full batch once, and refuses stale ids", async () => {
  const state = createInitialState();
  await startRecruitment(state, "三位角色", 3, { generate: async input => input.slot === 2 ? {} : response(input.slot) });
  const batch = state.recruitment!; const kept = structuredClone(batch.slots[0].candidate);
  const calls: RecruitmentGenerationInput[] = [];
  const dependencies = { generate: async (input: RecruitmentGenerationInput) => { calls.push(input); return response(input.slot); } };
  await assert.rejects(retryRecruitment(state, "older-batch", undefined, dependencies), /过期/);
  await assert.rejects(retryRecruitment(state, batch.id, 4, dependencies), /序号/);
  assert.equal(calls.length, 0);
  await retryRecruitment(state, batch.id, 1, dependencies);
  assert.equal(calls.length, 0);
  await retryRecruitment(state, batch.id, 2, dependencies);
  assert.equal(calls.length, 1); assert.equal(calls[0].slot, 2); assert.ok(calls[0].previousIssues.length > 0);
  assert.ok(calls[0].knownNames.includes(batch.slots[0].candidate!.name));
  assert.ok(calls[0].knownNames.includes(batch.slots[2].candidate!.name));
  assert.equal(batch.slots[1].attempts, 2); assert.deepEqual(batch.slots[0].candidate, kept); assert.equal(batch.applied, true);
  const applied = structuredClone(state.agents);
  await retryRecruitment(state, batch.id, undefined, dependencies);
  assert.equal(calls.length, 1); assert.deepEqual(state.agents, applied);
});

test("retry-all calls only failed or pending slots, never the successful slot", async () => {
  const state = createInitialState();
  await startRecruitment(state, "三位角色", 3, { generate: async input => input.slot === 1 ? response(1) : {} });
  state.recruitment!.slots[2].status = "pending";
  const calls: number[] = [];
  await retryRecruitment(state, state.recruitment!.id, undefined, { generate: async input => { calls.push(input.slot); return response(input.slot); } });
  assert.deepEqual(calls.sort(), [2, 3]); assert.equal(state.recruitment!.slots[0].attempts, 1);
  assert.equal(state.recruitment!.applied, true);
});

test("quota failure stops queued calls, keeps in-flight success, and exposes no raw credentials", async () => {
  const state = createInitialState(); let calls = 0;
  await startRecruitment(state, "十位角色", 10, { generate: async input => {
    calls++;
    if (input.slot === 1) throw new PalaceError("quota detail and test-secret", 502, "PROVIDER_QUOTA");
    await setImmediate(); return response(input.slot);
  } });
  assert.equal(calls, 2); assert.equal(state.recruitment!.slots[1].status, "succeeded");
  assert.ok(state.recruitment!.slots.slice(2).every(slot => slot.status === "failed" && slot.attempts === 0 && slot.errorCode === "PROVIDER_QUOTA"));
  assert.equal(JSON.stringify(state.recruitment).includes("test-secret"), false);
  assert.equal(JSON.stringify(state.recruitment).includes("quota detail"), false);
  assert.equal(state.recruitment!.applied, false);
});

test("duplicate names fail only their slot and never replace an existing member", async () => {
  const state = createInitialState(); state.agents[0].hired = true;
  const member = structuredClone(state.agents[0]);
  await startRecruitment(state, "三位角色", 3, { generate: async input => ({ candidates: [person(input.slot === 1 ? member.name : "同名候选")] }) });
  assert.equal(state.recruitment!.slots[0].errorCode, "RECRUITMENT_DUPLICATE");
  assert.ok(state.recruitment!.slots[0].issues.some(issue => issue.path === "candidates.0.name" && issue.message.includes(member.name)));
  assert.equal(state.recruitment!.slots.filter(slot => slot.status === "succeeded").length, 1);
  assert.deepEqual(state.agents[0], member); assert.equal(state.recruitment!.applied, false);
});

test("every generation excludes hired members, existing candidates, archived names, and newly completed slots", async () => {
  const state = createInitialState();
  state.agents[0].hired = true;
  state.agents[1].hired = false;
  state.agents[2].hired = false; state.agents[2].archivedAt = "2026-10-12T00:00:00.000Z";
  const existingNames = state.agents.map(agent => agent.name);
  const calls: RecruitmentGenerationInput[] = [];
  await startRecruitment(state, "三位名字不同的角色", 3, { generate: async input => {
    calls.push(input);
    if (input.slot === 2) await setImmediate();
    return input.slot === 2 ? {} : response(input.slot);
  } });
  assert.equal(calls.length, 3);
  for (const input of calls) {
    for (const name of existingNames) assert.ok(input.knownNames.includes(name), `slot ${input.slot} should exclude ${name}`);
  }
  assert.ok(calls.find(input => input.slot === 3)!.knownNames.includes("新候选1"));
  const lateCandidate = { ...person("后来出现的候选"), id: "late-candidate", hired: false };
  state.agents.push(lateCandidate);
  await retryRecruitment(state, state.recruitment!.id, 2, { generate: async input => {
    calls.push(input);
    for (const name of [...existingNames, lateCandidate.name, "新候选1", "新候选3"]) {
      assert.ok(input.knownNames.includes(name), `manual retry should exclude ${name}`);
    }
    return response(input.slot);
  } });
  assert.equal(calls.length, 4);
  assert.equal(state.recruitment!.applied, true);
});

test("duplicates of existing candidates and archived characters are rejected without another model call", async () => {
  for (const archived of [false, true]) {
    const state = createInitialState();
    const existing = state.agents[0]; existing.hired = false;
    if (archived) existing.archivedAt = "2026-10-12T00:00:00.000Z";
    let calls = 0;
    await startRecruitment(state, "一位新角色", 1, { generate: async () => {
      calls++; return { candidates: [person(existing.name)] };
    } });
    assert.equal(calls, 1);
    assert.equal(state.recruitment!.slots[0].errorCode, "RECRUITMENT_DUPLICATE");
    assert.equal(state.recruitment!.slots[0].attempts, 1);
    assert.equal(state.recruitment!.applied, false);
    assert.ok(state.recruitment!.slots[0].issues.some(issue => issue.message.includes(existing.name)));
    await retryRecruitment(state, state.recruitment!.id, 1, { generate: async input => {
      calls++;
      assert.ok(input.knownNames.includes(existing.name));
      assert.ok(input.previousIssues.some(issue => issue.path === "candidates.0.name" && issue.message.includes(existing.name)));
      return response(input.slot);
    } });
    assert.equal(calls, 2);
    assert.equal(state.recruitment!.slots[0].attempts, 2);
    assert.equal(state.recruitment!.applied, true);
  }
});

test("duplicate matching normalizes case, full-width characters, and whitespace while identifying the existing name", async () => {
  for (const [existingName, generatedName] of [
    ["Alice", "alice"],
    ["Alice", "ＡＬＩＣＥ"],
    ["Ａｌｉｃｅ", "Alice"],
    ["清禾", "清　禾"],
    ["清 禾", "清禾"],
  ]) {
    const state = createInitialState(); state.agents[0].name = existingName;
    let calls = 0;
    await startRecruitment(state, "避免重名", 1, { generate: async () => {
      calls++; return { candidates: [person(generatedName)] };
    } });
    assert.equal(calls, 1);
    const failed = state.recruitment!.slots[0];
    assert.equal(failed.errorCode, "RECRUITMENT_DUPLICATE", `${generatedName} duplicates ${existingName}`);
    assert.ok(failed.issues.some(issue => issue.path === "candidates.0.name" && issue.message.includes(existingName)));
    assert.equal(state.recruitment!.applied, false);
  }
});

test("two in-flight generations choosing equivalent names retain one candidate and reject the other", async () => {
  const state = createInitialState();
  let calls = 0; let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  await startRecruitment(state, "两位不同名字的角色", 2, { generate: async input => {
    calls++;
    assert.equal(input.knownNames.includes("Luna"), false);
    if (calls === 2) release();
    await bothStarted;
    return { candidates: [person(input.slot === 1 ? "Luna" : "ＬＵＮＡ")] };
  } });
  assert.equal(calls, 2);
  const slots = state.recruitment!.slots;
  assert.equal(slots.filter(slot => slot.status === "succeeded").length, 1);
  assert.equal(slots.filter(slot => slot.errorCode === "RECRUITMENT_DUPLICATE").length, 1);
  const acceptedName = slots.find(slot => slot.status === "succeeded")!.candidate!.name;
  const rejected = slots.find(slot => slot.status === "failed")!;
  assert.ok(rejected.issues.some(issue => issue.message.includes(acceptedName)));
  assert.ok(slots.every(slot => slot.attempts === 1));
  assert.equal(state.recruitment!.applied, false);
});

test("a newly hired member can invalidate only a conflicting cached slot between retries", async () => {
  const state = createInitialState();
  const lateMember = { ...person("稍后入庭的成员"), id: "late-member", hired: true };
  await startRecruitment(state, "两位角色", 2, { generate: async input => input.slot === 1 ? { candidates: [person(lateMember.name)] } : {} });
  const batch = state.recruitment!;
  assert.equal(batch.slots[0].status, "succeeded");
  state.agents.push(lateMember);
  await retryRecruitment(state, batch.id, 2, { generate: async () => response(2) });
  assert.equal(batch.slots[0].status, "failed"); assert.equal(batch.slots[0].attempts, 1);
  assert.equal(batch.slots[0].errorCode, "RECRUITMENT_DUPLICATE");
  assert.equal(batch.slots[1].status, "succeeded"); assert.equal(batch.applied, false);
  const kept = structuredClone(batch.slots[1].candidate);
  await retryRecruitment(state, batch.id, 1, { generate: async () => response(1) });
  assert.equal(batch.applied, true); assert.strictEqual(state.agents[0], lateMember);
  assert.deepEqual(batch.slots[1].candidate, kept);
});

test("budget exhaustion marks unstarted slots retryable instead of losing completed candidates", async () => {
  const state = createInitialState(); let clock = 0; let calls = 0;
  await startRecruitment(state, "五位角色", 5, { now: () => clock, generate: async input => { calls++; clock = 325_001; return response(input.slot); } });
  assert.equal(calls, 1); assert.equal(state.recruitment!.slots[0].status, "succeeded");
  assert.ok(state.recruitment!.slots.slice(1).every(slot => slot.errorCode === "RECRUITMENT_BUDGET" && slot.attempts === 0));
});

test("JSON diagnostics expose safe numeric positions and structural classes without output fragments", () => {
  let syntax: unknown;
  try { parseModelObject('{"private-fragment":true "other":3}'); } catch (error) { syntax = error; }
  const failure = recruitmentFailure(syntax);
  assert.equal(failure.code, "PROVIDER_FORMAT");
  assert.match(failure.issues[0].message, /字符位置 \d+/);
  assert.equal(failure.issues[0].message.includes("private-fragment"), false);
  for (const [raw, expected] of [['{} {}', /多个JSON对象/], ['[{}]', /数组包裹/], ['{"x":', /未闭合/]] as const) {
    try { parseModelObject(raw); assert.fail("must reject invalid structure"); }
    catch (error) { assert.match(recruitmentFailure(error).issues[0].message, expected); }
  }
  const secret = recruitmentFailure(new PalaceError("arbitrary secret-string line 5", 502, "PROVIDER_FORMAT"));
  assert.equal(JSON.stringify(secret).includes("secret-string"), false);
});
