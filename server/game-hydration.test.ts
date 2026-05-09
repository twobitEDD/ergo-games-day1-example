import assert from "node:assert/strict";
import test from "node:test";
import { deriveCompletionFromStatus } from "../src/game-hydration";
import type { ApiGame, ApiGameStatus } from "../src/api";

const makeGame = (): ApiGame => ({
  gameId: "game_123",
  gameType: "tic_tac_toe",
  createdByUserId: "user_x",
  participants: ["user_x", "user_o"],
  playerSeats: {
    X: "user_x",
    O: "user_o",
  },
  trustLabel: "NO_WAGER_TRUSTED_SCAFFOLD",
  state: {
    board: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    open: false,
  },
});

test("deriveCompletionFromStatus keeps joined game active while ongoing", () => {
  const status: ApiGameStatus = { kind: "ongoing", turn: "X" };
  const completion = deriveCompletionFromStatus(makeGame(), status);
  assert.deepEqual(completion, {
    finished: false,
    kind: "ongoing",
    winnerSymbol: null,
    winnerUserId: null,
  });
});

test("deriveCompletionFromStatus maps winners to user ids", () => {
  const status: ApiGameStatus = { kind: "won", winner: "O" };
  const completion = deriveCompletionFromStatus(makeGame(), status);
  assert.deepEqual(completion, {
    finished: true,
    kind: "won",
    winnerSymbol: "O",
    winnerUserId: "user_o",
  });
});
