import type { AccountTransferIntent, TransferIntentReadModel } from "@twobitedd/ergo-account-model";

const ACTIVE_STATUSES: AccountTransferIntent["status"][] = [
  "draft",
  "queued_backend",
  "awaiting_onchain",
  "broadcasting_onchain",
  "confirming_onchain",
];

export const deriveTransferIntentReadModel = (intents: AccountTransferIntent[]): TransferIntentReadModel => {
  const sorted = [...intents].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    intents: sorted,
    activeCount: sorted.filter((intent) => ACTIVE_STATUSES.includes(intent.status)).length,
    completedCount: sorted.filter((intent) => intent.status === "completed").length,
    failedCount: sorted.filter((intent) => intent.status === "failed").length,
    lastUpdatedAt: sorted[0]?.updatedAt,
  };
};
