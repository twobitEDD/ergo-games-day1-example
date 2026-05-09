import type { GameType } from "@twobitedd/ergo-games-interface";
import type {
  OnChainIntentRecord,
  RatifiableEventRecord,
  RatificationBatchRecord,
  RatificationCheckpointRecord,
} from "./store";

export type TruthLedgerState = "off_chain_pending" | "ratified" | "on_chain_source";
export type TruthLedgerAuthoritativeState = "ratified" | "on_chain_source";
export type TruthLedgerItemKind = "game_event" | "onchain_intent";

export interface TruthLedgerItem {
  id: string;
  state: TruthLedgerState;
  kind: TruthLedgerItemKind;
  mode: "off_chain" | "ratification" | "on_chain_gate";
  action: string;
  gameId: string;
  gameType: GameType | "unknown";
  occurredAt: string;
  userIds: string[];
  eventId?: number;
  batchId?: string;
  txRef?: string;
}

export interface TruthLedgerLayer {
  count: number;
  recent: TruthLedgerItem[];
}

export interface TruthLedgerView {
  authoritativeStates: TruthLedgerAuthoritativeState[];
  layers: {
    off_chain_pending: TruthLedgerLayer;
    ratified: TruthLedgerLayer;
    on_chain_source: TruthLedgerLayer;
  };
}

interface TruthLedgerInput {
  events: RatifiableEventRecord[];
  checkpoint: RatificationCheckpointRecord;
  batches: RatificationBatchRecord[];
  onChainIntents: OnChainIntentRecord[];
  gameTypeById: Map<string, GameType>;
}

const byOccurredAtDesc = (a: TruthLedgerItem, b: TruthLedgerItem) =>
  Date.parse(b.occurredAt) - Date.parse(a.occurredAt);

const batchForEvent = (eventId: number, batches: RatificationBatchRecord[]) =>
  batches.find((batch) => batch.fromEventId <= eventId && eventId <= batch.toEventId);

const txRefForBatch = (batch: RatificationBatchRecord | undefined) => batch?.txId ?? batch?.payloadHash;

const toEventItem = (
  event: RatifiableEventRecord,
  checkpoint: RatificationCheckpointRecord,
  batches: RatificationBatchRecord[],
  gameTypeById: Map<string, GameType>
): TruthLedgerItem => {
  const state: TruthLedgerState =
    event.eventId <= checkpoint.lastAnchoredEventId ? "ratified" : "off_chain_pending";
  const matchingBatch = batchForEvent(event.eventId, batches);
  return {
    id: `event_${event.eventId}`,
    state,
    kind: "game_event",
    mode: state === "ratified" ? "ratification" : "off_chain",
    action: event.type,
    gameId: event.gameId,
    gameType: gameTypeById.get(event.gameId) ?? "unknown",
    occurredAt: event.createdAt,
    userIds: [event.actorUserId],
    eventId: event.eventId,
    batchId: matchingBatch?.batchId,
    txRef: txRefForBatch(matchingBatch),
  };
};

const toOnChainItem = (intent: OnChainIntentRecord, gameTypeById: Map<string, GameType>): TruthLedgerItem => ({
  id: intent.intentId,
  state: "on_chain_source",
  kind: "onchain_intent",
  mode: "on_chain_gate",
  action: intent.action,
  gameId: intent.gameId,
  gameType: gameTypeById.get(intent.gameId) ?? "unknown",
  occurredAt: intent.createdAt,
  userIds: [intent.createdByUserId],
  txRef: intent.txHash,
});

export const buildTruthLedgerView = (input: TruthLedgerInput, recentPerLayer = 8): TruthLedgerView => {
  const eventItems = input.events.map((event) => toEventItem(event, input.checkpoint, input.batches, input.gameTypeById));
  const onChainItems = input.onChainIntents.map((intent) => toOnChainItem(intent, input.gameTypeById));
  const allItems = [...eventItems, ...onChainItems].sort(byOccurredAtDesc);

  const offChainPending = allItems.filter((entry) => entry.state === "off_chain_pending");
  const ratified = allItems.filter((entry) => entry.state === "ratified");
  const onChainSource = allItems.filter((entry) => entry.state === "on_chain_source");

  return {
    authoritativeStates: ["ratified", "on_chain_source"],
    layers: {
      off_chain_pending: { count: offChainPending.length, recent: offChainPending.slice(0, recentPerLayer) },
      ratified: { count: ratified.length, recent: ratified.slice(0, recentPerLayer) },
      on_chain_source: { count: onChainSource.length, recent: onChainSource.slice(0, recentPerLayer) },
    },
  };
};
