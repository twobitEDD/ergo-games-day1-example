import { createHash } from "node:crypto";

export type ChainNetwork = "testnet" | "mainnet";
export type WalletMode = "simulated" | "ergo";

export interface ServerWalletStatus {
  mode: WalletMode;
  network: ChainNetwork;
  addressConfigured: boolean;
  secretConfigured: boolean;
  ready: boolean;
  reason?: string;
  address?: string;
  secretFingerprint?: string;
  balanceNanoErg?: string;
  balanceStatus: "available" | "unknown";
}

const normalizeNetwork = (candidate: string | undefined): ChainNetwork => {
  if (candidate?.toLowerCase() === "testnet") return "testnet";
  if (candidate?.toLowerCase() === "mainnet") return "mainnet";
  return "mainnet";
};

const normalizeMode = (candidate: string | undefined): WalletMode => {
  if (candidate?.toLowerCase() === "ergo") return "ergo";
  return "simulated";
};

const toFingerprint = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 12);

const parseNanoErg = (candidate: string | undefined) => {
  const normalized = String(candidate ?? "").trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) return undefined;
  return normalized;
};

export class ServerWalletManager {
  private readonly mode: WalletMode;
  private readonly network: ChainNetwork;
  private readonly address?: string;
  private readonly secret?: string;
  private readonly simulatedBalanceNanoErg?: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.mode = normalizeMode(env.DAY1_CHAIN_MODE);
    this.network = normalizeNetwork(env.DAY1_CHAIN_NETWORK);
    this.address = env.DAY1_SERVER_WALLET_ADDRESS?.trim() || undefined;
    this.secret = env.DAY1_SERVER_WALLET_SECRET?.trim() || undefined;
    this.simulatedBalanceNanoErg = parseNanoErg(env.DAY1_SERVER_WALLET_BALANCE_NANOERG) ?? "1000000000";
  }

  getMode() {
    return this.mode;
  }

  getNetwork() {
    return this.network;
  }

  getStatus(): ServerWalletStatus {
    const addressConfigured = Boolean(this.address);
    const secretConfigured = Boolean(this.secret);
    const ready = addressConfigured && secretConfigured;
    const reason = ready ? undefined : "Server wallet requires address + secret configuration.";

    return {
      mode: this.mode,
      network: this.network,
      addressConfigured,
      secretConfigured,
      ready,
      reason,
      address: this.address,
      secretFingerprint: this.secret ? toFingerprint(this.secret) : undefined,
      balanceNanoErg: this.mode === "simulated" && ready ? this.simulatedBalanceNanoErg : undefined,
      balanceStatus: this.mode === "simulated" && ready ? "available" : "unknown",
    };
  }
}
