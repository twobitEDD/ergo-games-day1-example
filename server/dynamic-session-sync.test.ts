import assert from "node:assert/strict";
import test from "node:test";
import { waitForAuthTokenWithRetry } from "../src/dynamicSessionSync.ts";

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
