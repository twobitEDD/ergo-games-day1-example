// Back-compat bridge: Day1 now treats @twobitedd/ergo-games-interface as source of truth.
export type {
  ApiCreateGameRequest,
  ApiGameTypeListResponse,
  GameType,
  GameTypeMetadata,
  RuntimeGameStatus,
} from "@twobitedd/ergo-games-interface";
export { GAME_TYPES } from "@twobitedd/ergo-games-interface";

export interface RuntimeEventEnvelope<TType extends string, TPayload> {
  eventType: TType;
  gameType: GameType;
  createdAt: string;
  payload: TPayload;
}
