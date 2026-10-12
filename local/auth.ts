import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<boolean>();
const user = Object.freeze({ userId: "local-owner", displayName: "本机主人", email: "local-owner@localhost", fullName: "本机主人" });

/** 主人，只有本机回环 HTTP 服务器在完成 Host/Origin 检查后才会调用此函数。 */
export function withLocalRequest<T>(operation: () => Promise<T>): Promise<T> { return context.run(true, operation); }
export async function getChatGPTUser() { return context.getStore() ? user : null; }
