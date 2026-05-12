import assert from "node:assert/strict";
import test from "node:test";
import {
  isDynamicConfigurationError,
  retryWithBoundedBackoff,
  waitForAuthTokenWithRetry,
} from "../src/dynamicSessionSync.ts";

test("waitForAuthTokenWithRetry resolves once token appears", async () => {
  const observedAttempts: Array<{ attempt: number; max: number }> = [];
  let reads = 0;

  const token = await waitForAuthTokenWithRetry({
    maxRetries: 4,
    retryDelayMs: 1,
    getToken: () => {
      reads += 1;
      return reads >= 3 ? "jwt-token" : "";
    },
    sleep: async () => Promise.resolve(),
    onRetry: (attempt, max) => observedAttempts.push({ attempt, max }),
  });

  assert.equal(token, "jwt-token");
  assert.deepEqual(observedAttempts, [
    { attempt: 1, max: 4 },
    { attempt: 2, max: 4 },
  ]);
});

test("waitForAuthTokenWithRetry throws a user-facing guidance error", async () => {
  await assert.rejects(
    waitForAuthTokenWithRetry({
      maxRetries: 2,
      retryDelayMs: 1,
      getToken: () => null,
      sleep: async () => Promise.resolve(),
    }),
    /Dynamic auth token was unavailable/
  );
});

test("retryWithBoundedBackoff retries with bounded exponential delays", async () => {
  const observedDelays: number[] = [];
  let attempts = 0;
  const result = await retryWithBoundedBackoff({
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 16,
    run: async () => {
      attempts += 1;
      if (attempts < 4) {
        throw new Error("temporary");
      }
      return "ok";
    },
    sleep: async (delayMs) => {
      observedDelays.push(delayMs);
    },
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 4);
  assert.deepEqual(observedDelays, [10, 16, 16]);
});

test("isDynamicConfigurationError detects known Dynamic config failures", () => {
  assert.equal(isDynamicConfigurationError(new Error("boom DYNAMIC_AUTH_NOT_CONFIGURED")), true);
  assert.equal(isDynamicConfigurationError(new Error("boom DYNAMIC_AUTH_UNAVAILABLE")), true);
  assert.equal(isDynamicConfigurationError(new Error("some other failure")), false);
});
