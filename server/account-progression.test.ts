import assert from "node:assert/strict";
import test from "node:test";
import { deriveAccountProgression } from "../src/accountProgression.ts";

test("deriveAccountProgression marks ready when backend truth has identity+wallet", () => {
  const progression = deriveAccountProgression({
    hasBackendSession: true,
    securityState: {
      userId: "user_1",
      wallet: {
        status: "bound_stub",
        address: "9habc123",
        linked: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      identities: [
        {
          provider: "dynamic",
          subject: "dyn_123",
          linked: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(progression.identityReadiness, "ready");
  assert.equal(progression.custodyReadiness, "ready");
  assert.equal(progression.payoutReadiness, "ready");
  assert.equal(progression.overallReadiness, "ready");
  assert.equal(progression.payoutRails[0]?.rail, "ergo");
  assert.equal(progression.payoutRails[0]?.state, "connected");
  assert.equal(progression.payoutRails[1]?.rail, "paypal");
  assert.equal(progression.payoutRails[1]?.state, "coming_soon");
});

test("deriveAccountProgression keeps paypal optional and non-blocking", () => {
  const progression = deriveAccountProgression({
    hasBackendSession: true,
    securityState: {
      userId: "user_2",
      wallet: {
        status: "unbound",
        linked: false,
      },
      identities: [
        {
          provider: "dynamic",
          subject: "dyn_456",
          linked: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(progression.payoutRails.find((rail) => rail.rail === "paypal")?.state, "coming_soon");
  assert.equal(progression.payoutReadiness, "needs_action");
  assert.equal(progression.nextActionHint, "Link an Ergo wallet to prepare payouts.");
});
