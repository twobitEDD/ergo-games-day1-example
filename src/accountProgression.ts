import type {
  AccountProgressionSnapshot,
  AccountReadinessState,
  PayoutRailConnection,
  PayoutRailConnectionState,
} from "@twobitedd/ergo-account-model";
import type { ApiAccountSecurityState } from "./api";

export interface DeriveAccountProgressionInput {
  hasBackendSession: boolean;
  securityState: ApiAccountSecurityState | null;
  now?: Date;
}

const toReadiness = (value: boolean): AccountReadinessState => (value ? "ready" : "needs_action");

const toErgoRailState = (input: {
  hasBackendSession: boolean;
  walletLinked: boolean;
}): PayoutRailConnectionState => {
  if (!input.hasBackendSession) return "not_connected";
  return input.walletLinked ? "connected" : "connectable";
};

export const deriveAccountProgression = (input: DeriveAccountProgressionInput): AccountProgressionSnapshot => {
  const now = (input.now ?? new Date()).toISOString();
  const identityLinked = Boolean(input.hasBackendSession && input.securityState && input.securityState.identities.length > 0);
  const walletLinked = Boolean(input.securityState?.wallet.linked && input.securityState.wallet.address?.trim());
  const ergoRailState = toErgoRailState({ hasBackendSession: input.hasBackendSession, walletLinked });
  const payoutRails: PayoutRailConnection[] = [
    {
      rail: "ergo",
      state: ergoRailState,
      optional: true,
      note:
        ergoRailState === "connected"
          ? "Ergo payout rail is connected and payout-capable."
          : "Ergo payout rail is available when you link a wallet.",
      lastCheckedAt: input.securityState?.lastUpdatedAt ?? now,
    },
    {
      rail: "paypal",
      state: "coming_soon",
      optional: true,
      note: "PayPal rail is planned and optional. It does not block gameplay.",
      lastCheckedAt: now,
    },
  ];
  const payoutReady = payoutRails.some((rail) => rail.rail === "ergo" && rail.state === "connected");
  const nextActionHint = !input.hasBackendSession
    ? "Start or restore your Day1 session."
    : !identityLinked
      ? "Reconnect identity with Dynamic -> Day1 session."
      : !walletLinked
        ? "Link an Ergo wallet to prepare payouts."
        : undefined;

  return {
    schema: "ergo-account-progression",
    version: 1,
    identityReadiness: toReadiness(identityLinked),
    custodyReadiness: toReadiness(walletLinked),
    payoutReadiness: toReadiness(payoutReady),
    overallReadiness: toReadiness(identityLinked && walletLinked),
    payoutRails,
    nextActionHint,
    derivedFrom: "backend_truth",
    updatedAt: now,
  };
};
