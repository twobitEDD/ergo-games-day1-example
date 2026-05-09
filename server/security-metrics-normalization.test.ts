import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSecurityMetrics } from "../src/api";

test("normalizeSecurityMetrics flattens object snapshots returned by backend", () => {
  const normalized = normalizeSecurityMetrics({
    security: {
      login_failures: 2,
      login_success: 5,
    },
    endpoints: {
      "/api/auth/register:POST": 1,
    },
  });

  assert.deepEqual(normalized, [
    { key: "security.login_failures", count: 2 },
    { key: "security.login_success", count: 5 },
    { key: "endpoints./api/auth/register:POST", count: 1 },
  ]);
});

test("normalizeSecurityMetrics keeps valid array entries and drops invalid values", () => {
  const normalized = normalizeSecurityMetrics([
    { key: "security.login_success", count: 4 },
    { key: "security.login_failures", count: "3" },
    { key: "", count: 1 },
    { key: "security.bad", count: null },
    null,
  ]);

  assert.deepEqual(normalized, [
    { key: "security.login_success", count: 4 },
    { key: "security.login_failures", count: 3 },
  ]);
});

test("normalizeSecurityMetrics returns empty array for nullish metrics payloads", () => {
  assert.deepEqual(normalizeSecurityMetrics(null), []);
  assert.deepEqual(normalizeSecurityMetrics(undefined), []);
});
