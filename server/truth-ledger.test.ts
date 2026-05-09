import assert from "node:assert/strict";
import test from "node:test";
import { buildTruthLedgerView } from "./truth-ledger";

test("truth ledger classifies pending, ratified, and on-chain source records", () => {
  const truth = buildTruthLedgerView(
    {
      events: [
        {
          eventId: 1,
          gameId: "game_a",
          type: "MOVE_APPLIED",
          actorUserId: "user_a",
          cell: 0,
          nextTurn: "O",
          winner: undefined,
          drawn: false,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          eventId: 2,
          gameId: "game_a",
          type: "MOVE_APPLIED",
          actorUserId: "user_b",
          cell: 4,
          nextTurn: "X",
          winner: undefined,
          drawn: false,
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      checkpoint: {
        lastAnchoredEventId: 1,
        lastBatchId: "batch_1",
        updatedAt: "2026-01-01T00:00:10.000Z",
      },
      batches: [
        {
          batchId: "batch_1",
          status: "confirmed",
          fromEventId: 1,
          toEventId: 1,
          recordCount: 1,
          recordHash: "hash1",
          merkleRoot: "merkle1",
          txId: "tx_1",
          adapterMode: "simulated",
          chainNetwork: "testnet",
          payloadHash: "payload_1",
          confirmationStatus: "confirmed",
          confirmationDepth: 1,
          finalized: false,
          reorgDetected: false,
          artifactJson: "{}",
          createdAt: "2026-01-01T00:00:09.000Z",
        },
      ],
      onChainIntents: [
        {
          intentId: "intent_1",
          gameId: "game_chain",
          createdByUserId: "user_c",
          action: "SETTLE_GAME",
          status: "confirmed_stub",
          txHash: "0xchain",
          createdAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      gameTypeById: new Map([
        ["game_a", "tic_tac_toe"],
        ["game_chain", "coin_flip_demo"],
      ]),
    },
    5
  );

  assert.deepEqual(truth.authoritativeStates, ["ratified", "on_chain_source"]);
  assert.equal(truth.layers.ratified.count, 1);
  assert.equal(truth.layers.off_chain_pending.count, 1);
  assert.equal(truth.layers.on_chain_source.count, 1);
  assert.equal(truth.layers.ratified.recent[0]?.id, "event_1");
  assert.equal(truth.layers.ratified.recent[0]?.batchId, "batch_1");
  assert.equal(truth.layers.ratified.recent[0]?.txRef, "tx_1");
  assert.equal(truth.layers.off_chain_pending.recent[0]?.id, "event_2");
  assert.equal(truth.layers.on_chain_source.recent[0]?.id, "intent_1");
  assert.equal(truth.layers.on_chain_source.recent[0]?.state, "on_chain_source");
});
