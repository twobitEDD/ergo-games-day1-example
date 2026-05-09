import type { GameType, GameTypeMetadata } from "@twobitedd/ergo-games-interface";
import type { GameEngine } from "./contracts";
import { coinFlipDemoEngine } from "./engines/coin-flip-demo-engine";
import { ticTacToeEngine } from "./engines/tic-tac-toe-engine";

const engines: GameEngine[] = [ticTacToeEngine, coinFlipDemoEngine];

const engineMap = new Map<GameType, GameEngine>(engines.map((engine) => [engine.metadata.gameType, engine]));

export const getGameEngine = (gameType: GameType): GameEngine | undefined => engineMap.get(gameType);

export const listGameMetadata = (): GameTypeMetadata[] => engines.map((engine) => engine.metadata);

export const DEFAULT_GAME_TYPE: GameType = "tic_tac_toe";
