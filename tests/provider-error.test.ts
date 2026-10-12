import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError } from "../lib/server/provider-error.ts";
import { publicError } from "../lib/server/errors.ts";
import { retryableModelFormatError } from "../lib/server/model-json.ts";

test("quota rejection takes precedence over misleading 401, 403 and 429 transport statuses", () => {
  for (const status of [401, 403, 429]) {
    const result = classifyProviderError(status, JSON.stringify({ error: { code: "pre_consume_token_quota_failed", message: "gateway-specific description" } }));
    assert.equal(result.code, "PROVIDER_QUOTA");
    assert.equal(result.message, "模型服务余额不足，请充值或在庭院设置更换 API Key。");
    assert.equal(retryableModelFormatError(result), false);
  }
});

test("an explicit balance failure is recognized even when its code is absent", () => {
  for (const response of [
    JSON.stringify({ error: { message: "token quota is not enough, token remain quota: 0.12 need quota: 4.56" } }),
    JSON.stringify({ message: "Insufficient balance" }),
    "余额不足，请补充账户资金",
  ]) assert.equal(classifyProviderError(403, response).code, "PROVIDER_QUOTA");
});

test("ordinary unauthorized failures and rate limits retain their separate meanings", () => {
  for (const status of [401, 403]) {
    const result = classifyProviderError(status, '{"error":{"code":"invalid_api_key","message":"Invalid key"}}');
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.ok(result.message.includes("密钥与模型权限"));
  }
  const rateLimit = classifyProviderError(429, '{"error":{"code":"rate_limit_exceeded","message":"Tokens per minute exceeded"}}');
  assert.ok(rateLimit.message.includes("请求过于频繁"));
  assert.equal(rateLimit.message.includes("余额"), false);
});

test("malformed or unexpected gateway bodies never become user-facing messages", () => {
  for (const raw of ["<html>upstream unavailable</html>", "{broken", "null", "[]", '{"error":7}']) {
    const result = classifyProviderError(500, raw);
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.equal(result.message, "模型服务暂时出错（HTTP 500），本次操作未完成。");
  }
});

test("public quota errors omit gateway balances, returned credentials and raw payloads", () => {
  const secret = "test-provider-secret-never-display";
  const raw = JSON.stringify({ error: { code: "pre_consume_token_quota_failed", message: `token quota is not enough, token remain quota: 123.456 need quota: 789.012 key: ${secret}` } });
  const visible = JSON.stringify(publicError(classifyProviderError(401, raw)));
  assert.equal(visible.includes(secret), false);
  assert.equal(visible.includes("123.456"), false);
  assert.equal(visible.includes("789.012"), false);
  assert.equal(visible.includes("token quota"), false);
});
