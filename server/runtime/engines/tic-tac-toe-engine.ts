import type { GameEngine } from "../contracts";
import { deriveStatusFromRecord } from "../contracts";

export const ticTacToeEngine: GameEngine = {
  metadata: {
    gameType: "tic_tac_toe",
    displayName: "Tic-Tac-Toe",
    description: "Classic deterministic 3x3 game using Day1 rule-engine scaffolding.",
    supportsMoves: true,
    maturity: "ga",
  },
  getStatus(game) {
    return deriveStatusFromRecord(game);
  },
  applyMove({ sessionService, gameId, userId, cell }) {
    return sessionService.applyMove(gameId, userId, cell);
  },
};
