import type {
  ApiCreateGameRequest,
  LeaderboardEntry,
  PlayerProfile,
  PlayerRecentActivity,
  PlayerRewardSnapshot,
  SecurityMetricPoint,
  TicTacToeMoveAppliedEvent,
  TicTacToeMoveRejected,
  TicTacToeState,
  GameType,
  GameTypeMetadata,
  RuntimeGameStatus,
} from "@twobitedd/ergo-games-interface";
import type { ProgressiveAccountCapabilities } from "@twobitedd/ergo-account-model";

const SESSION_HEADER = "x-day1-session-token";
const CSRF_HEADER = "x-day1-csrf-token";
const DEVICE_HEADER = "x-day1-device-id";
const DEVICE_STORAGE_KEY = "day1_device_id";
const FALLBACK_API_BASE_PATH = "";

let csrfTokenCache: string | undefined;
let deviceIdCache: string | undefined;
let sessionTokenCache: string | undefined;

interface AuthBootstrapPayload {
  sessionToken?: string;
  csrfToken?: string;
}

export interface ApiCapabilityEnvelope {
  scaffold: true;
  capabilities: ProgressiveAccountCapabilities;
  authority: { authority: "day1-server-user-id"; userId: string };
}

export interface ApiSession {
  sessionId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  deviceId?: string;
  mfaVerifiedAt?: string;
}

export interface ApiProfile extends Omit<PlayerProfile, "walletStatus"> {
  email: string;
  mfaEnabled?: boolean;
  walletStatus: "unbound" | "bound_stub";
}

export interface ApiAccountSecurityState {
  userId: string;
  wallet: {
    status: "unbound" | "bound_stub";
    address?: string;
    linked: boolean;
    updatedAt?: string;
  };
  identities: Array<{
    provider: string;
    subject: string;
    linked: boolean;
    emailAtLink?: string;
    displayNameAtLink?: string;
    createdAt: string;
    lastSeenAt: string;
  }>;
  lastUpdatedAt: string;
}

export interface ApiGame {
  gameId: string;
  gameType: GameType;
  createdByUserId: string;
  participants: string[];
  playerSeats: {
    X: string;
    O: string | null;
  };
  trustLabel: "NO_WAGER_TRUSTED_SCAFFOLD";
  state: TicTacToeState | { phase: "placeholder"; open: boolean };
}

export interface ApiGameListItem {
  gameId: string;
  gameType: GameType;
  playerSeats: {
    X: string;
    O: string | null;
  };
  participants: string[];
  status: ApiGameStatus;
  createdAt: string;
  updatedAt: string;
}

export type ApiRewardSnapshot = PlayerRewardSnapshot;

interface ApiIntent {
  intentId: string;
  status: "pending_stub" | "confirmed_stub";
  txHash?: string;
}

export interface ApiServerWalletStatus {
  mode: "simulated" | "ergo";
  network: "testnet" | "mainnet";
  addressConfigured: boolean;
  secretConfigured: boolean;
  ready: boolean;
  reason?: string;
  address?: string;
  secretFingerprint?: string;
  balanceNanoErg?: string;
  balanceStatus: "available" | "unknown";
}

export interface ApiRatificationSchedule {
  intervalMs: number;
  enabled: boolean;
  updatedAt: string;
  source: "env" | "api";
}

export interface ApiRatificationCheckpoint {
  lastAnchoredEventId: number;
  lastBatchId?: string;
  lastSuccessfulRatificationAt?: string;
  lastRatifiedBlockHeight?: number;
  updatedAt: string;
}

export interface ApiRatificationBatch {
  batchId: string;
  status: "submitting" | "awaiting_signature" | "submitted" | "confirmed" | "failed";
  fromEventId: number;
  toEventId: number;
  recordCount: number;
  recordHash: string;
  merkleRoot: string;
  txId?: string;
  adapterMode: string;
  chainNetwork: "testnet" | "mainnet";
  payloadHash: string;
  confirmationStatus: "pending" | "confirmed" | "finalized" | "reorged" | "unknown";
  confirmationDepth: number;
  finalized: boolean;
  reorgDetected: boolean;
  signerPayloadJson?: string;
  submitError?: string;
  artifactJson: string;
  createdAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  finalizedAt?: string;
  lastCheckedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface ApiRatificationAdapterInfo {
  mode: "simulated" | "ergo";
  network: "testnet" | "mainnet";
  signerMode: "external" | "direct" | "public-sponsor";
  finalityDepth: number;
  externalSigner: boolean;
}

export type ApiTruthLedgerState = "off_chain_pending" | "ratified" | "on_chain_source";

export interface ApiTruthStackItem {
  id: string;
  state: ApiTruthLedgerState;
  kind: "game_event" | "onchain_intent";
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

export interface ApiTruthStackLayer {
  count: number;
  recent: ApiTruthStackItem[];
}

export interface ApiTruthStack {
  authoritativeStates: Array<"ratified" | "on_chain_source">;
  layers: {
    off_chain_pending: ApiTruthStackLayer;
    ratified: ApiTruthStackLayer;
    on_chain_source: ApiTruthStackLayer;
  };
}

export type ApiRecentPlayer = PlayerRecentActivity;

export type ApiLeaderboardEntry = LeaderboardEntry;

export type ApiSecurityMetric = SecurityMetricPoint;

export type ApiGameStatus = RuntimeGameStatus;

export interface ApiGameCompletion {
  finished: boolean;
  kind: "ongoing" | "won" | "drawn";
  winnerSymbol: "X" | "O" | null;
  winnerUserId: string | null;
}

const getDeviceId = () => {
  if (deviceIdCache) return deviceIdCache;
  if (typeof window === "undefined") {
    deviceIdCache = "server-render-device";
    return deviceIdCache;
  }
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) {
    deviceIdCache = existing;
    return existing;
  }
  const generated = `dev_${crypto.randomUUID().slice(0, 12)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, generated);
  deviceIdCache = generated;
  return generated;
};

const isMutatingMethod = (method: string) => ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());

const parseBooleanEnvFlag = (value: unknown, fallback: boolean) => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const resolveApiBaseOrigin = () => {
  const explicitBase = String(import.meta.env.VITE_DAY1_API_BASE_URL ?? "").trim();
  if (explicitBase) return trimTrailingSlash(explicitBase);
  if (typeof window === "undefined") return FALLBACK_API_BASE_PATH;
  const forceSameOriginInProd = parseBooleanEnvFlag(import.meta.env.VITE_DAY1_FORCE_SAME_ORIGIN_API, true);
  if (import.meta.env.PROD && forceSameOriginInProd) {
    return window.location.origin;
  }
  return FALLBACK_API_BASE_PATH;
};

const toApiUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const baseOrigin = resolveApiBaseOrigin();
  return baseOrigin ? `${baseOrigin}${normalizedPath}` : normalizedPath;
};

const isAuthBootstrapPayload = (value: unknown): value is AuthBootstrapPayload =>
  Boolean(value) && typeof value === "object";

const fetchJson = async <T>(
  path: string,
  options: RequestInit = {},
  sessionToken?: string
): Promise<T> => {
  const headers = new Headers(options.headers ?? {});
  headers.set("Content-Type", "application/json");
  headers.set(DEVICE_HEADER, getDeviceId());
  const effectiveSessionToken = sessionToken ?? sessionTokenCache;
  if (effectiveSessionToken) headers.set(SESSION_HEADER, effectiveSessionToken);
  const method = String(options.method ?? "GET");
  if (isMutatingMethod(method) && csrfTokenCache) {
    headers.set(CSRF_HEADER, csrfTokenCache);
  }

  const response = await fetch(toApiUrl(path), {
    ...options,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    let detail = `${response.status}`;
    let errorCode: string | null = null;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      errorCode = typeof body.error === "string" ? body.error : null;
      const note = typeof body.note === "string" ? body.note : null;
      detail = [errorCode, note].filter(Boolean).join(" - ") || detail;
    } catch {
      // no-op fallback to status code
    }
    if (
      response.status === 401 &&
      !sessionToken &&
      sessionTokenCache &&
      (errorCode === "MISSING_SESSION" || errorCode === "SESSION_NOT_FOUND")
    ) {
      sessionTokenCache = undefined;
    }
    throw new Error(`${path} failed (${response.status}): ${detail}`);
  }

  const payload = (await response.json()) as T & { csrfToken?: string };
  if (typeof payload === "object" && payload && "csrfToken" in payload && payload.csrfToken) {
    csrfTokenCache = payload.csrfToken;
  }
  if (isAuthBootstrapPayload(payload) && typeof payload.sessionToken === "string" && payload.sessionToken.trim()) {
    sessionTokenCache = payload.sessionToken.trim();
  }
  return payload;
};

export const apiRegister = (payload: { displayName: string; email: string; password: string }) =>
  fetchJson<{
    scaffold: true;
    session: ApiSession;
    sessionToken: string;
    profile: ApiProfile;
    sessionHeader: string;
    sessionCookie: string;
    csrfHeader: string;
    csrfToken: string;
    deviceHeader: string;
  }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const apiLogin = (payload: {
  email: string;
  password: string;
  mfaCode?: string;
  rememberDevice?: boolean;
  deviceLabel?: string;
}) =>
  fetchJson<{
    scaffold: true;
    session: ApiSession;
    sessionToken: string;
    profile: ApiProfile;
    sessionHeader: string;
    sessionCookie: string;
    csrfHeader: string;
    csrfToken: string;
    deviceHeader: string;
    mfaMethod?: "TOTP";
  }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const apiDynamicLogin = (payload: {
  authToken: string;
  email?: string;
  displayName?: string;
}) =>
  fetchJson<{
    scaffold: true;
    session: ApiSession;
    sessionToken: string;
    profile: ApiProfile;
    sessionHeader: string;
    sessionCookie: string;
    csrfHeader: string;
    csrfToken: string;
    deviceHeader: string;
    authMode: "dynamic";
  }>("/api/auth/dynamic/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const apiGuestLogin = (displayName = "Guest Player") =>
  fetchJson<{
    scaffold: true;
    session: ApiSession;
    sessionToken: string;
    profile: ApiProfile;
    sessionHeader: string;
    sessionCookie: string;
    csrfHeader: string;
    csrfToken: string;
    deviceHeader: string;
    authMode: "guest";
  }>("/api/auth/guest", {
    method: "POST",
    body: JSON.stringify({ displayName }),
  });

export const apiAuthSync = (payload: { displayName?: string; email?: string; externalAuthRef?: string }) =>
  fetchJson<{
    scaffold: true;
    session: ApiSession;
    sessionToken: string;
    profile: ApiProfile;
    sessionHeader: string;
    sessionCookie: string;
    csrfHeader: string;
    csrfToken: string;
    deviceHeader: string;
    authMode: "dynamic_compatibility";
  }>("/api/auth/sync", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const apiGetSession = (sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    active: true;
    session: ApiSession;
    profile: ApiProfile;
    capabilities: ProgressiveAccountCapabilities;
    authority: ApiCapabilityEnvelope["authority"];
    csrfToken?: string;
    csrfHeader: string;
  }>(
    "/api/auth/session",
    { method: "GET" },
    sessionToken
  );

export const apiGetCapabilities = (sessionToken?: string) =>
  fetchJson<ApiCapabilityEnvelope>("/api/me/capabilities", { method: "GET" }, sessionToken);

export const apiSignOut = async (sessionToken?: string) => {
  const payload = await fetchJson<{ scaffold: true; signedOut: true; sessionId: string }>(
    "/api/auth/signout",
    { method: "POST", body: JSON.stringify({}) },
    sessionToken
  );
  sessionTokenCache = undefined;
  csrfTokenCache = undefined;
  return payload;
};

export const clearClientAuthBootstrap = () => {
  sessionTokenCache = undefined;
  csrfTokenCache = undefined;
};

export const apiGetProfile = (sessionToken?: string) =>
  fetchJson<{ scaffold: true; profile: ApiProfile }>("/api/me/profile", { method: "GET" }, sessionToken);

export const apiGetAccountSecurityState = (sessionToken?: string) =>
  fetchJson<{ scaffold: true; securityState: ApiAccountSecurityState }>(
    "/api/me/security-state",
    { method: "GET" },
    sessionToken
  );

export const apiBindWallet = (walletAddress: string, sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    walletBinding: { status: "bound_stub"; network: string };
    profile: ApiProfile;
  }>(
    "/api/wallet/bind",
    {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    },
    sessionToken
  );

export const apiCreateGame = (gameType?: ApiCreateGameRequest["gameType"], sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    game: ApiGame;
    gameType: GameType;
    noWagerTrustLabel: string;
  }>("/api/game/create", { method: "POST", body: JSON.stringify(gameType ? { gameType } : {}) }, sessionToken);

export const apiListGameTypes = (sessionToken?: string) =>
  fetchJson<{ scaffold: true; gameTypes: GameTypeMetadata[]; requestedBy: string }>(
    "/api/game-types",
    { method: "GET" },
    sessionToken
  );

export const apiListGames = (status: "all" | "open" | "active" | "completed" = "all", sessionToken?: string) =>
  fetchJson<{ scaffold: true; games: ApiGameListItem[]; requestedBy: string }>(
    `/api/games?status=${status}`,
    { method: "GET" },
    sessionToken
  );

export const apiListRecentPlayers = (limit = 20, sessionToken?: string) =>
  fetchJson<{ scaffold: true; players: ApiRecentPlayer[]; requestedBy: string }>(
    `/api/players/recent?limit=${limit}`,
    { method: "GET" },
    sessionToken
  );

export const apiGetLeaderboard = (limit = 20, sessionToken?: string) =>
  fetchJson<{ scaffold: true; leaderboard: ApiLeaderboardEntry[]; requestedBy: string; note: string }>(
    `/api/leaderboard?limit=${limit}`,
    { method: "GET" },
    sessionToken
  );

export const apiMove = (gameId: string, cell: number, sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    result:
      | {
          ok: true;
          state: TicTacToeState;
          event: TicTacToeMoveAppliedEvent;
        }
      | (TicTacToeMoveRejected & {
          expectedTurn?: "X" | "O";
          actorSymbol?: "X" | "O" | null;
        })
      | {
          ok: false;
          reason: "PLAYER_NOT_IN_GAME" | "NOT_YOUR_TURN" | "WAITING_FOR_OPPONENT" | "UNSUPPORTED_FOR_GAME_TYPE";
          expectedTurn?: "X" | "O";
          actorSymbol?: "X" | "O" | null;
        };
    game: ApiGame;
    status: ApiGameStatus | null;
    playerSymbol: "X" | "O" | null;
    rewardSnapshot: ApiRewardSnapshot | null;
    completion: ApiGameCompletion;
  }>(
    `/api/game/${gameId}/move`,
    {
      method: "POST",
      body: JSON.stringify({ cell }),
    },
    sessionToken
  );

export const apiJoinGame = (gameId: string, sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    game: ApiGame;
    gameType: GameType;
    playerSymbol: "X" | "O" | null;
    status: ApiGameStatus;
  }>(
    `/api/game/${gameId}/join`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    sessionToken
  );

export const apiGetGame = (gameId: string, sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    game: ApiGame;
    status: ApiGameStatus;
    playerSymbol: "X" | "O" | null;
    rewardSnapshot: ApiRewardSnapshot | null;
    completion: ApiGameCompletion;
    noWagerTrustLabel: string;
  }>(`/api/game/${gameId}`, { method: "GET" }, sessionToken);

export const apiGetRewards = (sessionToken?: string) =>
  fetchJson<{ scaffold: true; rewardSnapshot: ApiRewardSnapshot }>(
    "/api/rewards/get",
    { method: "GET" },
    sessionToken
  );

export const apiCreateOnChainIntent = (gameId: string, sessionToken?: string) =>
  fetchJson<{ scaffold: true; intent: ApiIntent }>(
    "/api/onchain/intent/create",
    {
      method: "POST",
      body: JSON.stringify({ gameId, action: "SETTLE_GAME" }),
    },
    sessionToken
  );

export const apiGetIntentStatus = (intentId: string) =>
  fetchJson<{ scaffold: true; intent: ApiIntent }>(
    `/api/onchain/intent/${intentId}/status`,
    { method: "GET" }
  );

export const apiGetServerWalletStatus = (sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    wallet: ApiServerWalletStatus;
    requestedBy: string;
    note: string;
  }>("/api/server-wallet/status", { method: "GET" }, sessionToken);

export const apiGetRatificationSchedule = (sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    schedule: ApiRatificationSchedule;
    checkpoint: ApiRatificationCheckpoint;
    adapter: ApiRatificationAdapterInfo;
    requestedBy: string;
  }>("/api/ratification/schedule", { method: "GET" }, sessionToken);

export const apiSetRatificationSchedule = (
  payload: {
    intervalMs?: number;
    enabled?: boolean;
  },
  sessionToken?: string
) =>
  fetchJson<{
    scaffold: true;
    schedule: ApiRatificationSchedule;
    checkpoint: ApiRatificationCheckpoint;
    adapter: ApiRatificationAdapterInfo;
    requestedBy: string;
  }>(
    "/api/ratification/schedule",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    sessionToken
  );

export const apiRunRatification = (sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    run: {
      outcome: "confirmed" | "submitted" | "awaiting_signature" | "noop" | "skipped" | "error";
      reason?: string;
      skipReason?: string;
      reasonMessage?: string;
      batchId?: string;
      txId?: string;
      recordCount?: number;
      payloadHash?: string;
    };
    checkpoint: ApiRatificationCheckpoint;
    adapter: ApiRatificationAdapterInfo;
    requestedBy: string;
  }>("/api/ratification/run", { method: "POST", body: JSON.stringify({}) }, sessionToken);

export const apiListRatificationBatches = (limit = 25, sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    batches: ApiRatificationBatch[];
    checkpoint: ApiRatificationCheckpoint;
    adapter: ApiRatificationAdapterInfo;
    requestedBy: string;
  }>(`/api/ratification/batches?limit=${limit}`, { method: "GET" }, sessionToken);

export const apiGetTruthStack = (limit = 60, recent = 8, sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    truth: ApiTruthStack;
    requestedBy: string;
    generatedAt: string;
    note: string;
  }>(`/api/truth-stack?limit=${limit}&recent=${recent}`, { method: "GET" }, sessionToken);

export const apiSubmitSignedRatificationBatch = (batchId: string, signedTxHex: string, sessionToken?: string) =>
  fetchJson<{
    scaffold: true;
    run: {
      outcome: "confirmed" | "submitted" | "awaiting_signature" | "noop" | "skipped" | "error";
      reason?: string;
      skipReason?: string;
      reasonMessage?: string;
      batchId?: string;
      txId?: string;
      recordCount?: number;
      payloadHash?: string;
    };
    checkpoint: ApiRatificationCheckpoint;
    adapter: ApiRatificationAdapterInfo;
    requestedBy: string;
  }>(
    `/api/ratification/batches/${batchId}/submit-signed`,
    { method: "POST", body: JSON.stringify({ signedTxHex }) },
    sessionToken
  );

export const apiRequestRecovery = (email: string) =>
  fetchJson<{
    scaffold: true;
    accepted: true;
    resetTokenPreview?: string;
    expiresAt?: string;
  }>("/api/auth/recovery/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

export const apiResetRecovery = (token: string, newPassword: string) =>
  fetchJson<{ scaffold: true; reset: true }>("/api/auth/recovery/reset", {
    method: "POST",
    body: JSON.stringify({ token, newPassword }),
  });

export const apiStartTotpEnrollment = () =>
  fetchJson<{
    scaffold: true;
    enrollmentId: string;
    expiresAt: string;
    secret: string;
    otpauthUri: string;
  }>("/api/auth/mfa/totp/enroll/start", {
    method: "POST",
    body: JSON.stringify({}),
  });

export const apiVerifyTotpEnrollment = (code: string) =>
  fetchJson<{ scaffold: true; mfaEnabled: true }>("/api/auth/mfa/totp/enroll/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  });

export const apiDisableTotp = (code: string) =>
  fetchJson<{ scaffold: true; mfaEnabled: false }>("/api/auth/mfa/totp/disable", {
    method: "POST",
    body: JSON.stringify({ code }),
  });

export const apiListTrustedDevices = () =>
  fetchJson<{
    scaffold: true;
    devices: Array<{ deviceId: string; label?: string; createdAt: string; lastUsedAt: string; revokedAt?: string }>;
  }>("/api/security/devices", { method: "GET" });

export const apiTrustCurrentDevice = (label: string) =>
  fetchJson<{ scaffold: true; trusted: true; deviceId: string }>("/api/security/devices/trust", {
    method: "POST",
    body: JSON.stringify({ label }),
  });

export const apiRevokeDevice = (deviceId: string) =>
  fetchJson<{ scaffold: true; revoked: true; deviceId: string }>(`/api/security/devices/${deviceId}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const apiListSessions = () =>
  fetchJson<{
    scaffold: true;
    sessions: Array<{
      sessionId: string;
      userId: string;
      createdAt: string;
      expiresAt: string;
      deviceId?: string;
      mfaVerifiedAt?: string;
    }>;
  }>("/api/security/sessions", { method: "GET" });

export const apiRevokeSession = (sessionId: string) =>
  fetchJson<{ scaffold: true; revoked: true; sessionId: string }>(`/api/security/sessions/${sessionId}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const apiGetSecurityEvents = (limit = 20) =>
  fetchJson<{ scaffold: true; events: Array<{ eventType: string; outcome: string; createdAt: string }> }>(
    `/api/security/events?limit=${limit}`,
    { method: "GET" }
  );

const toMetricCount = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const appendObjectMetricEntries = (
  source: Record<string, unknown>,
  output: ApiSecurityMetric[],
  keyPrefix = ""
) => {
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = keyPrefix ? `${keyPrefix}.${rawKey}` : rawKey;
    const count = toMetricCount(rawValue);
    if (count !== null) {
      output.push({ key, count });
      continue;
    }
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      appendObjectMetricEntries(rawValue as Record<string, unknown>, output, key);
    }
  }
};

export const normalizeSecurityMetrics = (rawMetrics: unknown): ApiSecurityMetric[] => {
  if (Array.isArray(rawMetrics)) {
    return rawMetrics.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const key = (entry as { key?: unknown }).key;
      const count = toMetricCount((entry as { count?: unknown }).count);
      if (typeof key !== "string" || !key.trim() || count === null) {
        return [];
      }
      return [{ key, count }];
    });
  }

  if (!rawMetrics || typeof rawMetrics !== "object") {
    return [];
  }

  const normalized: ApiSecurityMetric[] = [];
  appendObjectMetricEntries(rawMetrics as Record<string, unknown>, normalized);
  return normalized;
};

export const apiGetSecurityMetrics = async () => {
  const payload = await fetchJson<{ scaffold: true; metrics: unknown }>("/api/security/metrics", {
    method: "GET",
  });
  return {
    ...payload,
    metrics: normalizeSecurityMetrics(payload.metrics),
  } as { scaffold: true; metrics: ApiSecurityMetric[] };
};
