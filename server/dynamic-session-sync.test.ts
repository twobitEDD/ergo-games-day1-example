import assert from "node:assert/strict";
import test from "node:test";
import {
  isDynamicConfigurationError,
  isHardDynamicBridgeError,
  isTransientDynamicBridgeError,
  retryWithBoundedBackoff,
  shouldRetryDynamicBridgeError,
  shouldStartAutoBridgeAttempt,
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

test("dynamic bridge retry classifier only retries transient failures", () => {
  assert.equal(isHardDynamicBridgeError(new Error("/api/auth/dynamic/login failed (401): DYNAMIC_TOKEN_INVALID")), true);
  assert.equal(isTransientDynamicBridgeError(new Error("fetch failed")), true);
  assert.equal(isTransientDynamicBridgeError(new Error("/api/auth/session failed (503): SERVICE_UNAVAILABLE")), true);
  assert.equal(
    shouldRetryDynamicBridgeError(new Error("/api/auth/dynamic/login failed (401): DYNAMIC_TOKEN_INVALID")),
    false
  );
  assert.equal(shouldRetryDynamicBridgeError(new Error("NetworkError when attempting to fetch resource.")), true);
});

test("auto-bridge guard blocks reconnect spam and hard-failed identities", () => {
  const now = Date.now();
  const baseInput = {
    dynamicReady: true,
    identityKey: "user:dyn_123",
    identityChanged: false,
    becameReady: false,
    hasBackendSession: false,
    hasAuthBlockingReason: false,
    authMode: null as "jwt_verified" | null,
    syncInFlight: false,
    syncInProgress: false,
    nowMs: now,
    cooldownUntilMs: 0,
    attemptsForIdentity: 0,
    maxAttemptsPerIdentity: 3,
    lastAttemptAtMs: 0,
    minAttemptGapMs: 1500,
    hardBlockedIdentityKey: null as string | null,
  };

  assert.equal(shouldStartAutoBridgeAttempt(baseInput), true);
  assert.equal(shouldStartAutoBridgeAttempt({ ...baseInput, lastAttemptAtMs: now - 200 }), false);
  assert.equal(shouldStartAutoBridgeAttempt({ ...baseInput, attemptsForIdentity: 3 }), false);
  assert.equal(
    shouldStartAutoBridgeAttempt({ ...baseInput, hardBlockedIdentityKey: "user:dyn_123", identityChanged: false }),
    false
  );
});
