import test from "node:test";
import assert from "node:assert/strict";
import { characterTimeFields } from "../lib/character-time.ts";
import { createInitialState } from "../lib/seeds.ts";

test("robot model chronology contains its manufacturing date without leaking the compatibility age", () => {
  const agent = createInitialState().agents[0];
  agent.age = 0;
  agent.species = { ...agent.species, kind: "synthetic", manufacturedAt: "2026-10-01" };
  const fields = characterTimeFields(agent);
  assert.deepEqual(fields, { manufacturedAt: "2026-10-01" });
  assert.equal(Object.hasOwn(fields, "age"), false);
  assert.equal(JSON.stringify(fields).includes('"age"'), false);
  assert.equal(agent.age, 0);
  assert.equal(agent.species.manufacturedAt, "2026-10-01");
});

test("human and other biological or mythical characters retain chronological age", () => {
  const agent = createInitialState().agents[0];
  assert.deepEqual(characterTimeFields(agent), { age: agent.age });
  agent.species.kind = "mythical";
  agent.age = 850;
  assert.deepEqual(characterTimeFields(agent), { age: 850 });
  assert.equal(Object.hasOwn(characterTimeFields(agent), "manufacturedAt"), false);
});
