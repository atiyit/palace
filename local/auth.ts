import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<boolean>();
const user = Object.freeze({ userId: "local-owner", displayName: "本机主人", email: "local-owner@localhost", fullName: "本机主人" });

/** 这道门由我替主人守着——只有本机回环 HTTP 服务器在完成 Host/Origin 检查后，才会调用此函数呢。 */
export function withLocalRequest<T>(operation: () => Promise<T>): Promise<T> { return context.run(true, operation); }
export async function getChatGPTUser() { return context.getStore() ? user : null; }
