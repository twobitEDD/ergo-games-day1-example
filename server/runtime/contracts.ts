import { statusOf } from "@twobitedd/ergo-games-interface";
import type { GameType, GameTypeMetadata, RuntimeGameStatus } from "@twobitedd/ergo-games-interface";
import type { GameRecord, JoinGameResult, StoreMoveResult } from "../store";

export interface GameSessionService {
  createGame(createdByUserId: string, gameType: GameType): GameRecord;
  joinGame(gameId: string, userId: string): JoinGameResult;
  getGame(gameId: string): GameRecord | null;
  applyMove(gameId: string, userId: string, cell: number): StoreMoveResult | null;
}

export interface RewardPolicy {
  onGameSettled(input: { game: GameRecord; status: RuntimeGameStatus }): void;
}

export interface SettlementPolicy {
  canCreateIntent(input: { game: GameRecord; action: "SETTLE_GAME" | "SYNC_RESULT" }): { allowed: boolean; reason?: string };
}

export interface GameEngine {
  readonly metadata: GameTypeMetadata;
  getStatus(game: GameRecord): RuntimeGameStatus;
  applyMove(input: { sessionService: GameSessionService; gameId: string; userId: string; cell: number }): StoreMoveResult | null;
}

export const deriveStatusFromRecord = (game: GameRecord): RuntimeGameStatus => {
  if (game.gameType === "tic_tac_toe") {
    return statusOf(game.state.board, game.state.open);
  }
  return game.playerSeats.O === null ? { kind: "open" } : { kind: "ongoing", turn: "X" };
};
