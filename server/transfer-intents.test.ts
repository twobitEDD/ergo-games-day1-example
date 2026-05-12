import assert from "node:assert/strict";
import test from "node:test";
import type { AccountTransferIntent } from "@twobitedd/ergo-account-model";
import { deriveTransferIntentReadModel } from "../src/transferIntents.ts";

const baseIntent = (overrides: Partial<AccountTransferIntent>): AccountTransferIntent => ({
  intentId: "intent_base",
  mediation: "backend_and_onchain",
  assetKind: "ERG",
  amount: "1000000",
  source: { userId: "user_a", ergoAddress: "9ha" },
  destination: { userId: "user_b", ergoAddress: "9hb" },
  status: "draft",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("deriveTransferIntentReadModel counts active/completed/failed intents", () => {
  const model = deriveTransferIntentReadModel([
    baseIntent({ intentId: "intent_1", status: "queued_backend", updatedAt: "2026-01-01T00:00:01.000Z" }),
    baseIntent({ intentId: "intent_2", status: "completed", updatedAt: "2026-01-01T00:00:02.000Z" }),
    baseIntent({ intentId: "intent_3", status: "failed", updatedAt: "2026-01-01T00:00:03.000Z" }),
  ]);

  assert.equal(model.intents[0]?.intentId, "intent_3");
  assert.equal(model.activeCount, 1);
  assert.equal(model.completedCount, 1);
  assert.equal(model.failedCount, 1);
  assert.equal(model.lastUpdatedAt, "2026-01-01T00:00:03.000Z");
});
