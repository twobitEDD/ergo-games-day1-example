import { createHash, randomUUID } from "node:crypto";
import type { Day1Store } from "./store";
import type { ChainNetwork, ServerWalletManager } from "./server-wallet";

export interface RatifiableEventRecord {
  eventId: number;
  createdAt: string;
  gameId: string;
  type: string;
  actorUserId: string;
  cell: number;
  nextTurn?: "X" | "O";
  winner?: "X" | "O";
  drawn: boolean;
}

export interface RatificationArtifactRecord {
  eventId: number;
  createdAt: string;
  gameId: string;
  type: string;
  actorUserId: string;
  payload: {
    cell: number;
    nextTurn: "X" | "O" | null;
    winner: "X" | "O" | null;
    drawn: boolean;
  };
}

export interface RatificationArtifact {
  version: "day1-ratification-v1";
  fromEventId: number;
  toEventId: number;
  recordCount: number;
  records: RatificationArtifactRecord[];
  recordHash: string;
  merkleRoot: string;
}

export type RatificationStatus = "submitting" | "submitted" | "confirmed" | "failed";

export interface RatificationRunResult {
  outcome: "confirmed" | "submitted" | "awaiting_signature" | "noop" | "skipped" | "error";
  reason?: string;
  batchId?: string;
  txId?: string;
  recordCount?: number;
  payloadHash?: string;
}

export interface RatificationSchedule {
  intervalMs: number;
  enabled: boolean;
  updatedAt: string;
  source: "env" | "api";
}

interface RatificationChainSubmitResponse {
  txId: string;
  immediatelyConfirmed: boolean;
  payloadHash: string;
}

interface RatificationChainCheckResponse {
  state: "pending" | "confirmed" | "finalized" | "reorged" | "unknown";
  confirmations: number;
  finalized: boolean;
  reorgDetected: boolean;
}

export interface RatificationChainAdapter {
  submit(
    artifact: RatificationArtifact,
    input?: { signedTxHex?: string; payloadHash?: string }
  ): Promise<RatificationChainSubmitResponse>;
  check(txId: string): Promise<RatificationChainCheckResponse>;
  getCurrentBlockHeight(): Promise<number | undefined>;
  getMode(): "simulated" | "ergo";
  getNetwork(): ChainNetwork;
  supportsExternalSigner(): boolean;
  getSignerMode(): "external" | "direct" | "public-sponsor";
}

const toClampedInteger = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

export const parseRatificationConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const defaultIntervalMs = toClampedInteger(env.DAY1_RATIFY_INTERVAL_MS, 20_000);
  const minimumIntervalMs = toClampedInteger(env.DAY1_RATIFY_MIN_INTERVAL_MS, 5_000);
  const maximumIntervalMs = toClampedInteger(env.DAY1_RATIFY_MAX_INTERVAL_MS, 300_000);
  const batchLimit = toClampedInteger(env.DAY1_RATIFY_BATCH_MAX_RECORDS, 50);
  const allowApiOverride = String(env.DAY1_RATIFY_ALLOW_API_OVERRIDE ?? "false").toLowerCase() === "true";
  const finalityDepth = toClampedInteger(env.DAY1_RATIFY_FINALITY_DEPTH, 6);
  return { defaultIntervalMs, minimumIntervalMs, maximumIntervalMs, batchLimit, allowApiOverride, finalityDepth };
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256Hex = (content: string) => createHash("sha256").update(content).digest("hex");
const normalizeUrl = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/g, "");
};
const defaultExplorerUrlForNetwork = (network: ChainNetwork) =>
  network === "mainnet" ? "https://api.ergoplatform.com" : "https://api-testnet.ergoplatform.com";
const withTxPath = (baseUrl: string, txId: string) => `${baseUrl}/api/v1/transactions/${encodeURIComponent(txId)}`;

const toMerkleRoot = (leafHashes: string[]) => {
  if (leafHashes.length === 0) return sha256Hex("empty");
  let level = [...leafHashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0];
};

export const buildDeterministicArtifact = (events: RatifiableEventRecord[]): RatificationArtifact => {
  const records = [...events]
    .sort((left, right) => (left.eventId === right.eventId ? left.createdAt.localeCompare(right.createdAt) : left.eventId - right.eventId))
    .map((event) => ({
      eventId: event.eventId,
      createdAt: event.createdAt,
      gameId: event.gameId,
      type: event.type,
      actorUserId: event.actorUserId,
      payload: {
        cell: event.cell,
        nextTurn: event.nextTurn ?? null,
        winner: event.winner ?? null,
        drawn: event.drawn,
      },
    }));

  const leafHashes = records.map((record) => sha256Hex(canonicalJson(record)));
  const contentHash = sha256Hex(canonicalJson(records));

  return {
    version: "day1-ratification-v1",
    fromEventId: records[0]?.eventId ?? 0,
    toEventId: records[records.length - 1]?.eventId ?? 0,
    recordCount: records.length,
    records,
    recordHash: contentHash,
    merkleRoot: toMerkleRoot(leafHashes),
  };
};

class SimulatedRatificationChainAdapter implements RatificationChainAdapter {
  private readonly submissions = new Map<string, number>();
  private readonly blockStartHeight: number;
  private readonly blockIntervalMs: number;
  private readonly startedAtMs = Date.now();

  constructor(
    private readonly network: ChainNetwork,
    private readonly finalityDepth: number,
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.blockStartHeight = toClampedInteger(env.DAY1_SIMULATED_BLOCK_START_HEIGHT, 1_000_000);
    this.blockIntervalMs = toClampedInteger(env.DAY1_SIMULATED_BLOCK_INTERVAL_MS, 10_000);
  }

  async submit(artifact: RatificationArtifact): Promise<RatificationChainSubmitResponse> {
    const txId = `${this.network}_ratif_${randomUUID().replaceAll("-", "")}`;
    this.submissions.set(txId, 0);
    return { txId, immediatelyConfirmed: false, payloadHash: sha256Hex(canonicalJson(artifact)) };
  }

  async check(txId: string): Promise<RatificationChainCheckResponse> {
    const seen = this.submissions.get(txId);
    if (seen === undefined) return { state: "pending", confirmations: 0, finalized: false, reorgDetected: false };
    if (seen >= this.finalityDepth) {
      return { state: "finalized", confirmations: seen, finalized: true, reorgDetected: false };
    }
    if (seen >= 1) return { state: "confirmed", confirmations: seen, finalized: false, reorgDetected: false };
    this.submissions.set(txId, seen + 1);
    return { state: "pending", confirmations: 0, finalized: false, reorgDetected: false };
  }

  async getCurrentBlockHeight(): Promise<number | undefined> {
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    const syntheticHeight = this.blockStartHeight + Math.floor(elapsedMs / this.blockIntervalMs);
    return syntheticHeight;
  }

  getMode() {
    return "simulated" as const;
  }

  getNetwork() {
    return this.network;
  }

  supportsExternalSigner() {
    return false;
  }

  getSignerMode() {
    return "direct" as const;
  }
}

class ExternalSignerRequiredError extends Error {
  constructor(
    message: string,
    readonly payloadHash: string,
    readonly signerPayloadJson: string
  ) {
    super(message);
    this.name = "ExternalSignerRequiredError";
  }
}

class ErgoRatificationChainAdapter implements RatificationChainAdapter {
  private readonly nodeUrl?: string;
  private readonly explorerUrl?: string;
  private readonly signerMode: "external" | "direct" | "public-sponsor";

  constructor(
    private readonly network: ChainNetwork,
    private readonly finalityDepth: number,
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.nodeUrl = normalizeUrl(env.DAY1_ERGO_NODE_URL);
    this.explorerUrl = normalizeUrl(env.DAY1_ERGO_EXPLORER_URL) ?? defaultExplorerUrlForNetwork(network);
    const configuredSignerMode = String(env.DAY1_ERGO_SIGNING_MODE ?? "external")
      .toLowerCase()
      .trim();
    if (configuredSignerMode === "direct") {
      this.signerMode = "direct";
    } else if (
      configuredSignerMode === "public-sponsor" ||
      configuredSignerMode === "public_sponsor" ||
      configuredSignerMode === "publicsponsor"
    ) {
      this.signerMode = "public-sponsor";
    } else {
      this.signerMode = "external";
    }
  }

  async submit(
    artifact: RatificationArtifact,
    input: { signedTxHex?: string; payloadHash?: string } = {}
  ): Promise<RatificationChainSubmitResponse> {
    const payloadHash = input.payloadHash ?? sha256Hex(canonicalJson(artifact));
    if (!input.signedTxHex?.trim()) {
      const signerPayload = {
        version: "day1-ergo-ratification-signing-v1",
        network: this.network,
        signerMode: this.signerMode,
        payloadHash,
        artifact,
      };
      const reasonPrefix =
        this.signerMode === "public-sponsor"
          ? "PUBLIC_SPONSOR_SIGNER_REQUIRED"
          : "EXTERNAL_SIGNER_REQUIRED";
      throw new ExternalSignerRequiredError(
        `${reasonPrefix}: provide signed transaction bytes to submit in ergo mode.`,
        payloadHash,
        JSON.stringify(signerPayload)
      );
    }
    if (!this.nodeUrl) {
      throw new Error("ERGO_NODE_URL_MISSING: configure DAY1_ERGO_NODE_URL for ergo submit mode.");
    }
    const response = await this.postJson(`${this.nodeUrl}/transactions`, {
      txBytes: input.signedTxHex.trim(),
      payloadHash,
    });
    const txId = this.extractTxId(response) ?? `ergo_${sha256Hex(input.signedTxHex.trim()).slice(0, 32)}`;
    return { txId, immediatelyConfirmed: false, payloadHash };
  }

  async check(txId: string): Promise<RatificationChainCheckResponse> {
    const probes: Array<() => Promise<unknown>> = [];
    if (this.explorerUrl) probes.push(() => this.getJson(withTxPath(this.explorerUrl as string, txId)));
    if (this.nodeUrl) probes.push(() => this.getJson(`${this.nodeUrl}/transactions/${encodeURIComponent(txId)}`));
    if (probes.length === 0) return { state: "unknown", confirmations: 0, finalized: false, reorgDetected: false };

    for (const probe of probes) {
      try {
        const payload = await probe();
        const confirmations = this.extractConfirmations(payload);
        const reorgDetected = this.extractReorg(payload);
        const finalized = confirmations >= this.finalityDepth;
        if (reorgDetected) return { state: "reorged", confirmations, finalized: false, reorgDetected };
        if (finalized) return { state: "finalized", confirmations, finalized: true, reorgDetected: false };
        if (confirmations > 0) return { state: "confirmed", confirmations, finalized: false, reorgDetected: false };
        return { state: "pending", confirmations: 0, finalized: false, reorgDetected: false };
      } catch {
        // probe fallback
      }
    }
    return { state: "unknown", confirmations: 0, finalized: false, reorgDetected: false };
  }

  async getCurrentBlockHeight(): Promise<number | undefined> {
    const probes: Array<() => Promise<unknown>> = [];
    if (this.nodeUrl) probes.push(() => this.getJson(`${this.nodeUrl}/info`));
    if (this.explorerUrl) probes.push(() => this.getJson(`${this.explorerUrl}/api/v1/blocks?limit=1`));
    for (const probe of probes) {
      try {
        const payload = await probe();
        const height = this.extractBlockHeight(payload);
        if (height !== undefined) return height;
      } catch {
        // probe fallback
      }
    }
    return undefined;
  }

  getMode() {
    return "ergo" as const;
  }

  getNetwork() {
    return this.network;
  }

  supportsExternalSigner() {
    return this.signerMode === "external" || this.signerMode === "public-sponsor";
  }

  getSignerMode() {
    return this.signerMode;
  }

  private async postJson(url: string, body: unknown) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`ERGO_SUBMIT_HTTP_${response.status}:${text.slice(0, 256)}`);
      }
      return (await response.json().catch(() => ({}))) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getJson(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 404) return {};
      if (!response.ok) throw new Error(`ERGO_STATUS_HTTP_${response.status}`);
      return (await response.json().catch(() => ({}))) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractTxId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const objectPayload = payload as Record<string, unknown>;
    const txId = objectPayload.txId ?? objectPayload.id;
    return typeof txId === "string" && txId.trim() ? txId.trim() : undefined;
  }

  private extractConfirmations(payload: unknown): number {
    if (!payload || typeof payload !== "object") return 0;
    const objectPayload = payload as Record<string, unknown>;
    const candidate =
      objectPayload.confirmations ??
      objectPayload.numConfirmations ??
      objectPayload.confirmationCount ??
      objectPayload.confirmationsCount;
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  private extractReorg(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const objectPayload = payload as Record<string, unknown>;
    return Boolean(objectPayload.reorged ?? objectPayload.isReorged ?? objectPayload.orphaned);
  }

  private extractBlockHeight(payload: unknown): number | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const objectPayload = payload as Record<string, unknown>;
    const candidates: unknown[] = [
      objectPayload.fullHeight,
      objectPayload.headersHeight,
      objectPayload.maxPeerHeight,
      objectPayload.height,
      Array.isArray(objectPayload.items) && objectPayload.items.length > 0
        ? (objectPayload.items[0] as Record<string, unknown>)?.height
        : undefined,
      Array.isArray(payload) && payload.length > 0 ? (payload[0] as Record<string, unknown>)?.height : undefined,
    ];
    for (const candidate of candidates) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    }
    return undefined;
  }
}

export const createRatificationAdapter = (
  wallet: ServerWalletManager,
  config = parseRatificationConfig(),
  env: NodeJS.ProcessEnv = process.env
): RatificationChainAdapter => {
  if (wallet.getMode() === "ergo") return new ErgoRatificationChainAdapter(wallet.getNetwork(), config.finalityDepth, env);
  return new SimulatedRatificationChainAdapter(wallet.getNetwork(), config.finalityDepth, env);
};

export class RatificationService {
  private readonly config = parseRatificationConfig();
  private readonly adapter: RatificationChainAdapter;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Day1Store,
    private readonly wallet: ServerWalletManager,
    adapter?: RatificationChainAdapter
  ) {
    this.adapter = adapter ?? createRatificationAdapter(wallet);
    this.store.seedRatificationSchedule(this.config.defaultIntervalMs);
  }

  start() {
    if (this.timer) return;
    this.configureTimer();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getSchedule() {
    return this.store.getRatificationSchedule();
  }

  getCheckpoint() {
    return this.store.getRatificationCheckpoint();
  }

  listBatches(limit = 20) {
    return this.store.listRatificationBatches(limit);
  }

  getAdapterInfo() {
    return {
      mode: this.adapter.getMode(),
      network: this.adapter.getNetwork(),
      signerMode: this.adapter.getSignerMode(),
      finalityDepth: this.config.finalityDepth,
      externalSigner: this.adapter.supportsExternalSigner(),
    };
  }

  updateSchedule(input: { intervalMs?: number; enabled?: boolean }) {
    const current = this.store.getRatificationSchedule();
    const requestedInterval = input.intervalMs ?? current.intervalMs;
    const intervalMs = Math.min(this.config.maximumIntervalMs, Math.max(this.config.minimumIntervalMs, requestedInterval));
    const enabled = input.enabled ?? current.enabled;
    const updated = this.store.updateRatificationSchedule({ intervalMs, enabled, source: "api" });
    this.configureTimer();
    return updated;
  }

  canOverrideFromApi() {
    return this.config.allowApiOverride;
  }

  async processPendingConfirmations() {
    const pending = this.store.listPendingRatificationSubmissions(30);
    for (const candidate of pending) {
      const check = await this.adapter.check(candidate.txId);
      this.store.updateRatificationConfirmation(candidate.batchId, {
        status:
          check.state === "finalized"
            ? "finalized"
            : check.state === "confirmed"
              ? "confirmed"
              : check.state === "reorged"
                ? "reorged"
                : check.state === "unknown"
                  ? "unknown"
                  : "pending",
        depth: check.confirmations,
        reorgDetected: check.reorgDetected,
      });
      if (check.state === "confirmed" || check.state === "finalized") {
        this.store.markRatificationBatchConfirmed(candidate.batchId);
      }
    }
  }

  async submitSignedBatch(batchId: string, signedTxHex: string): Promise<RatificationRunResult> {
    const existing = this.store.getRatificationBatch(batchId);
    if (!existing) return { outcome: "error", reason: "RATIFICATION_BATCH_NOT_FOUND", batchId };
    if (!existing.signerPayloadJson) return { outcome: "error", reason: "RATIFICATION_SIGNER_PAYLOAD_MISSING", batchId };
    const artifact = JSON.parse(existing.artifactJson) as RatificationArtifact;
    try {
      const submitted = await this.adapter.submit(artifact, {
        signedTxHex,
        payloadHash: existing.payloadHash,
      });
      this.store.markRatificationBatchSubmitted(batchId, submitted.txId);
      return {
        outcome: submitted.immediatelyConfirmed ? "confirmed" : "submitted",
        batchId,
        txId: submitted.txId,
        payloadHash: submitted.payloadHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Signed submission failed";
      this.store.markRatificationBatchFailed(batchId, message);
      return { outcome: "error", reason: message, batchId };
    }
  }

  async runNow(): Promise<RatificationRunResult> {
    if (this.running) return { outcome: "noop", reason: "RATIFICATION_ALREADY_RUNNING" };
    this.running = true;
    try {
      await this.processPendingConfirmations();
      const walletStatus = this.wallet.getStatus();
      if (!walletStatus.ready) {
        return { outcome: "skipped", reason: "SERVER_WALLET_NOT_READY" };
      }

      const checkpoint = this.store.getRatificationCheckpoint();
      const schedule = this.store.getRatificationSchedule();
      const nowMs = Date.now();
      const blockHeight = await this.adapter.getCurrentBlockHeight();
      const lastSuccessMs = checkpoint.lastSuccessfulRatificationAt
        ? Date.parse(checkpoint.lastSuccessfulRatificationAt)
        : Number.NaN;
      if (Number.isFinite(lastSuccessMs) && nowMs - lastSuccessMs < schedule.intervalMs) {
        return { outcome: "skipped", reason: "COOLDOWN_NOT_REACHED" };
      }
      if (
        blockHeight !== undefined &&
        checkpoint.lastRatifiedBlockHeight !== undefined &&
        blockHeight === checkpoint.lastRatifiedBlockHeight
      ) {
        return { outcome: "skipped", reason: "ALREADY_RATIFIED_THIS_BLOCK" };
      }
      const events = this.store.listRatifiableEventsSince(checkpoint.lastAnchoredEventId, this.config.batchLimit);
      if (events.length === 0) return { outcome: "noop", reason: "NO_ELIGIBLE_EVENTS" };

      const artifact = buildDeterministicArtifact(events);
      const batchId = `ratif_${randomUUID().slice(0, 12)}`;
      this.store.createRatificationBatch({
        batchId,
        status: "submitting",
        fromEventId: artifact.fromEventId,
        toEventId: artifact.toEventId,
        recordCount: artifact.recordCount,
        recordHash: artifact.recordHash,
        merkleRoot: artifact.merkleRoot,
        artifactJson: JSON.stringify(artifact),
        adapterMode: this.adapter.getMode(),
        chainNetwork: this.adapter.getNetwork(),
        payloadHash: sha256Hex(canonicalJson(artifact)),
      });

      try {
        const submitted = await this.adapter.submit(artifact);
        this.store.markRatificationBatchSubmitted(batchId, submitted.txId);
        this.store.recordRatificationSuccess({
          batchId,
          blockHeight,
        });
        if (submitted.immediatelyConfirmed) {
          this.store.markRatificationBatchConfirmed(batchId);
          return {
            outcome: "confirmed",
            batchId,
            txId: submitted.txId,
            recordCount: artifact.recordCount,
            payloadHash: submitted.payloadHash,
          };
        }
        return {
          outcome: "submitted",
          batchId,
          txId: submitted.txId,
          recordCount: artifact.recordCount,
          payloadHash: submitted.payloadHash,
        };
      } catch (error) {
        if (error instanceof ExternalSignerRequiredError) {
          this.store.markRatificationBatchAwaitingSignature(batchId, error.message, error.signerPayloadJson);
          return {
            outcome: "awaiting_signature",
            reason: error.message,
            batchId,
            recordCount: artifact.recordCount,
            payloadHash: error.payloadHash,
          };
        }
        const message = error instanceof Error ? error.message : "Submission failed";
        this.store.markRatificationBatchFailed(batchId, message);
        return { outcome: "error", reason: message, batchId };
      }
    } finally {
      this.running = false;
    }
  }

  private configureTimer() {
    this.stop();
    const schedule = this.store.getRatificationSchedule();
    if (!schedule.enabled) return;
    this.timer = setInterval(() => {
      void this.runNow();
    }, schedule.intervalMs);
    this.timer.unref();
  }
}
