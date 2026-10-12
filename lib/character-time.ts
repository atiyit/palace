import type { Agent } from "./types.ts";

/** 机器人档案里持久化的 age=0 只是一份兼容旧数据的占位，模型侧永远不会把它当作真实年龄来解读呀。 */
export function characterTimeFields(agent: Pick<Agent, "age" | "species">): { manufacturedAt?: string; age?: never } | { age: number; manufacturedAt?: never } {
  return agent.species.kind === "synthetic" ? { manufacturedAt: agent.species.manufacturedAt } : { age: agent.age };
}
