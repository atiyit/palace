import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (maxItems: number, maxLength: number, minItems = 1) => z.array(text(maxLength)).min(minItems).max(maxItems);
export const speciesSchema = z.object({
  name: text(60), kind: z.enum(["human", "synthetic", "mythical", "spirit", "alien", "other"]),
  form: text(800), origin: text(600), lifespan: text(300),
  manufacturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  innateTraits: list(6, 200), limitations: list(6, 200),
}).superRefine((species, context) => {
  if (species.kind === "synthetic" && !species.manufacturedAt) context.addIssue({ code: z.ZodIssueCode.custom, path: ["manufacturedAt"], message: "机器人需要填写制造日期（YYYY-MM-DD）。" });
  if (species.kind !== "synthetic" && species.manufacturedAt) context.addIssue({ code: z.ZodIssueCode.custom, path: ["manufacturedAt"], message: "制造日期仅用于机器人角色。" });
  if (species.manufacturedAt) {
    const date = new Date(`${species.manufacturedAt}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== species.manufacturedAt) context.addIssue({ code: z.ZodIssueCode.custom, path: ["manufacturedAt"], message: "制造日期必须是真实有效的日历日期。" });
  }
});
export function createCharacterProfileSchema(contentRulesEnabled = true) {
  return z.object({
    originStory: text(2000), formativeExperience: text(2000), expertise: text(2000), worldview: text(2000), desire: text(2000), fear: text(2000), contradiction: text(2000),
    habits: list(8, 300), favorites: list(8, 300), aversions: list(8, 300),
    socialStyle: text(2000), trustStyle: text(2000), rivalryStyle: text(2000), careStyle: text(2000), stressResponse: text(2000), growthDirection: text(2000), speechExamples: list(8, 400, contentRulesEnabled ? 2 : 1),
  }).refine(profile => {
    if (!contentRulesEnabled) return true;
    const length = Object.values(profile).reduce((sum, value) => sum + (Array.isArray(value) ? value.join("").length : value.length), 0);
    return length >= 700 && length <= 12000;
  }, "完整档案需要700至12000个字符，不能仅填性格标签。");
}
export function createRichCandidateSchema(contentRulesEnabled = true) {
  const score = () => z.number().int().min(contentRulesEnabled ? 15 : 0).max(contentRulesEnabled ? 95 : 100);
  return z.object({
    name: text(24), age: z.number().int().min(0).max(contentRulesEnabled ? 10000 : Number.MAX_SAFE_INTEGER), title: text(50), tagline: text(160), bio: text(1600).min(contentRulesEnabled ? 100 : 1),
    traits: list(8, 80, contentRulesEnabled ? 3 : 1), values: list(6, 150, contentRulesEnabled ? 2 : 1), boundaries: list(6, 200, contentRulesEnabled ? 2 : 1),
    voice: text(600), approach: text(800), appearance: text(1200), species: speciesSchema, profile: createCharacterProfileSchema(contentRulesEnabled),
    skills: z.object({ research: score(), planning: score(), execution: score(), creativity: score(), review: score(), coordination: score(), analysis: score(), knowledge: score(), insight: score(), learning: score(), writing: score(), aesthetics: score(), empathy: score(), communication: score(), negotiation: score(), resilience: score() }),
  }).superRefine((candidate, context) => {
    if (contentRulesEnabled && candidate.species.kind !== "synthetic" && candidate.age < 21) context.addIssue({ code: z.ZodIssueCode.custom, path: ["age"], message: "非机器人角色年龄需为21至10000。" });
  });
}
export function createProfileExpansionSchema(contentRulesEnabled = true) {
  return z.object({ species: speciesSchema, profile: createCharacterProfileSchema(contentRulesEnabled) }).strict();
}
export const characterProfileSchema = createCharacterProfileSchema();
export const richCandidateSchema = createRichCandidateSchema();
export const profileExpansionSchema = createProfileExpansionSchema();
