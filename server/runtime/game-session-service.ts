import type { GameType } from "@twobitedd/ergo-games-interface";
import type { Day1Store, GameRecord, JoinGameResult, StoreMoveResult } from "../store";
import type { GameSessionService } from "./contracts";

export class StoreBackedGameSessionService implements GameSessionService {
  constructor(private readonly store: Day1Store) {}

  createGame(createdByUserId: string, gameType: GameType): GameRecord {
    return this.store.createGame(createdByUserId, gameType);
  }

  joinGame(gameId: string, userId: string): JoinGameResult {
    return this.store.joinGame(gameId, userId);
  }

  getGame(gameId: string): GameRecord | null {
    return this.store.getGame(gameId);
  }

  applyMove(gameId: string, userId: string, cell: number): StoreMoveResult | null {
    return this.store.applyMove(gameId, userId, cell);
  }
}
