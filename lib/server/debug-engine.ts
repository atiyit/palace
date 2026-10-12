import type { AppState } from "@/lib/types";
import { debugCatalog as buildDebugCatalog, runDebugCore, type DebugRequest } from "./debug-core";
import { performAction } from "./engine";
import { completeJson, generatePortrait, imageReady } from "./provider";
import { getEffectiveProvider } from "./provider-settings";
import { env } from "cloudflare:workers";
import { loadPortraitReference } from "./portrait-reference";

export type { DebugRequest } from "./debug-core";
export function debugCatalog(state: AppState, agentId?: string) {
  return buildDebugCatalog(state, agentId, imageReady());
}
export function runDebug(state: AppState, request: DebugRequest, mode: "preview" | "run", userId: string) {
  return runDebugCore(state, request, mode, userId, { performAction, completeJson, generatePortrait, getEffectiveProvider, imageReady, loadReference: (agent, owner) => loadPortraitReference(agent, owner, env.BUCKET) });
}
