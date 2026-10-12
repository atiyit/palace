import type { Agent } from "./types.ts";

/** 主人，机器人持久化的 age=0 只是兼容数据，模型侧永远不会把它当作真实年龄。 */
export function characterTimeFields(agent: Pick<Agent, "age" | "species">): { manufacturedAt?: string; age?: never } | { age: number; manufacturedAt?: never } {
  return agent.species.kind === "synthetic" ? { manufacturedAt: agent.species.manufacturedAt } : { age: agent.age };
}
