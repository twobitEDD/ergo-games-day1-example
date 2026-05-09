import type { ApiGame, ApiGameCompletion, ApiGameStatus } from "./api";

export const deriveCompletionFromStatus = (
  gamePayload: ApiGame,
  statusPayload: ApiGameStatus
): ApiGameCompletion => {
  if (statusPayload.kind === "won") {
    return {
      finished: true,
      kind: "won",
      winnerSymbol: statusPayload.winner,
      winnerUserId: statusPayload.winner === "X" ? gamePayload.playerSeats.X : gamePayload.playerSeats.O,
    };
  }
  if (statusPayload.kind === "drawn") {
    return {
      finished: true,
      kind: "drawn",
      winnerSymbol: null,
      winnerUserId: null,
    };
  }
  return {
    finished: false,
    kind: "ongoing",
    winnerSymbol: null,
    winnerUserId: null,
  };
};
