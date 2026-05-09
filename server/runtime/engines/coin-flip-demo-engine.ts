import type { GameEngine } from "../contracts";

export const coinFlipDemoEngine: GameEngine = {
  metadata: {
    gameType: "coin_flip_demo",
    displayName: "Coin Flip (Demo Adapter)",
    description: "Placeholder adapter proving extension path through shared runtime contracts.",
    supportsMoves: false,
    maturity: "preview",
  },
  getStatus(game) {
    return game.playerSeats.O === null ? { kind: "open" } : { kind: "ongoing", turn: "X" };
  },
  applyMove() {
    return {
      ok: false,
      reason: "UNSUPPORTED_FOR_GAME_TYPE",
    };
  },
};
