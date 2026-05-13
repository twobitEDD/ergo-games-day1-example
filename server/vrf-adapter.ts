import { createHash, randomUUID } from "node:crypto";

export type VrfRequestStatus =
  | "requested"
  | "awaiting_submissions"
  | "finalized"
  | "error";

export interface VrfRequestRecord {
  requestId: string;
  roundId: string;
  gameId?: string;
  contractRef?: string;
  status: VrfRequestStatus;
  requestedAt: string;
  updatedAt: string;
  maxSubmissions: number;
  submissionsCount: number;
  seedHex?: string;
  error?: string;
  adapterMode: "mock" | "http_oracle";
}

export interface RequestVrfInput {
  gameId?: string;
  contractRef?: string;
  maxSubmissions?: number;
}

interface DemoRoundExplorerView {
  roundId: string;
  maxSubmissions: number;
  submissions: Array<{ operatorId: string; status: "valid" | "invalid" }>;
  validOperatorIds: string[];
  finalSeedHex?: string;
  finalizedAtEpochMs?: number;
}

interface VrfAdapter {
  getMode(): "mock" | "http_oracle";
  requestRandomness(input: RequestVrfInput): Promise<VrfRequestRecord>;
  syncRequest(requestId: string): Promise<VrfRequestRecord>;
  getRequest(requestId: string): VrfRequestRecord | null;
  listRequests(limit: number): VrfRequestRecord[];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function cloneRecord(record: VrfRequestRecord): VrfRequestRecord {
  return { ...record };
}

class MockVrfAdapter implements VrfAdapter {
  private requests = new Map<string, VrfRequestRecord>();

  getMode(): "mock" | "http_oracle" {
    return "mock";
  }

  async requestRandomness(input: RequestVrfInput): Promise<VrfRequestRecord> {
    const requestId = randomUUID();
    const roundId = `mock-round-${requestId.slice(0, 8)}`;
    const now = new Date().toISOString();
    const maxSubmissions = Math.max(1, input.maxSubmissions ?? 2);
    const seedHex = createHash("sha256")
      .update(`mock:${requestId}:${input.gameId ?? "none"}:${input.contractRef ?? "none"}`)
      .digest("hex");
    const record: VrfRequestRecord = {
      requestId,
      roundId,
      gameId: input.gameId,
      contractRef: input.contractRef,
      status: "finalized",
      requestedAt: now,
      updatedAt: now,
      maxSubmissions,
      submissionsCount: maxSubmissions,
      seedHex,
      adapterMode: "mock"
    };
    this.requests.set(requestId, record);
    return cloneRecord(record);
  }

  async syncRequest(requestId: string): Promise<VrfRequestRecord> {
    const existing = this.requests.get(requestId);
    if (!existing) {
      throw new Error(`vrf request not found: ${requestId}`);
    }
    return cloneRecord(existing);
  }

  getRequest(requestId: string): VrfRequestRecord | null {
    const existing = this.requests.get(requestId);
    return existing ? cloneRecord(existing) : null;
  }

  listRequests(limit: number): VrfRequestRecord[] {
    return [...this.requests.values()]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, limit)
      .map(cloneRecord);
  }
}

class HttpOracleVrfAdapter implements VrfAdapter {
  private requests = new Map<string, VrfRequestRecord>();
  private readonly oracleUrl: string;
  private readonly defaultMaxSubmissions: number;

  constructor(oracleUrl: string, defaultMaxSubmissions: number) {
    this.oracleUrl = oracleUrl.replace(/\/+$/, "");
    this.defaultMaxSubmissions = Math.max(1, defaultMaxSubmissions);
  }

  getMode(): "mock" | "http_oracle" {
    return "http_oracle";
  }

  async requestRandomness(input: RequestVrfInput): Promise<VrfRequestRecord> {
    const requestId = randomUUID();
    const roundId = `day1-vrf-${requestId.slice(0, 12)}`;
    const now = new Date().toISOString();
    const maxSubmissions = Math.max(1, input.maxSubmissions ?? this.defaultMaxSubmissions);
    await this.postJson("/api/rounds/start", {
      roundId,
      rewardPool: "1",
      entropyDomainTag: input.contractRef ?? `day1-contract:${input.gameId ?? "unknown"}`,
      maxSubmissions
    });
    const record: VrfRequestRecord = {
      requestId,
      roundId,
      gameId: input.gameId,
      contractRef: input.contractRef,
      status: "requested",
      requestedAt: now,
      updatedAt: now,
      maxSubmissions,
      submissionsCount: 0,
      adapterMode: "http_oracle"
    };
    this.requests.set(requestId, record);
    return this.syncRequest(requestId);
  }

  async syncRequest(requestId: string): Promise<VrfRequestRecord> {
    const existing = this.requests.get(requestId);
    if (!existing) {
      throw new Error(`vrf request not found: ${requestId}`);
    }
    const round = await this.getRound(existing.roundId);
    if (!round) {
      existing.status = "error";
      existing.error = "round not found on oracle";
      existing.updatedAt = new Date().toISOString();
      return cloneRecord(existing);
    }
    existing.submissionsCount = round.validOperatorIds.length;
    existing.updatedAt = new Date().toISOString();
    if (round.finalSeedHex) {
      existing.status = "finalized";
      existing.seedHex = round.finalSeedHex;
      existing.error = undefined;
      return cloneRecord(existing);
    }
    existing.status = "awaiting_submissions";
    if (round.validOperatorIds.length >= existing.maxSubmissions) {
      const finalized = await this.postJson<DemoRoundExplorerView>("/api/rounds/finalize", {});
      existing.status = "finalized";
      existing.seedHex = finalized.finalSeedHex;
      existing.submissionsCount = finalized.validOperatorIds.length;
      existing.error = undefined;
    }
    return cloneRecord(existing);
  }

  getRequest(requestId: string): VrfRequestRecord | null {
    const existing = this.requests.get(requestId);
    return existing ? cloneRecord(existing) : null;
  }

  listRequests(limit: number): VrfRequestRecord[] {
    return [...this.requests.values()]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  private async getRound(roundId: string): Promise<DemoRoundExplorerView | null> {
    const payload = await this.getJson<{
      rounds: DemoRoundExplorerView[];
    }>("/api/state");
    return payload.rounds.find((round) => round.roundId === roundId) ?? null;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.oracleUrl}${path}`, {
      method: "GET",
      headers: { "content-type": "application/json" }
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `oracle request failed: ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }

  private async postJson<T = unknown>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(`${this.oracleUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `oracle request failed: ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }
}

export const createVrfAdapterFromEnv = (): VrfAdapter => {
  const mode = (process.env.DAY1_VRF_ADAPTER_MODE ?? "").trim().toLowerCase();
  const oracleUrl = process.env.DAY1_VRF_ORACLE_URL?.trim();
  const defaultMaxSubmissions = parsePositiveInt(process.env.DAY1_VRF_MAX_SUBMISSIONS, 2);
  if (mode === "mock" || !oracleUrl) {
    return new MockVrfAdapter();
  }
  return new HttpOracleVrfAdapter(oracleUrl, defaultMaxSubmissions);
};
