import cors from "cors";
import express from "express";
import {
  buildProgressiveAccountCapabilities,
  type ProgressiveAccountCapabilities,
} from "@twobitedd/ergo-account-model";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type {
  ApiCreateGameRequest,
  GameType,
} from "@twobitedd/ergo-games-interface";
import { Day1Store, type GameRecord, type RateLimitPolicy } from "./store";
import { RatificationService } from "./ratification";
import { ServerWalletManager } from "./server-wallet";
import { createRateLimiterAdapter } from "./rate-limiter";
import { StoreBackedGameSessionService } from "./runtime/game-session-service";
import { Day1RewardPolicy } from "./runtime/reward-policy";
import { DEFAULT_GAME_TYPE, getGameEngine, listGameMetadata } from "./runtime/registry";
import { Day1SettlementPolicy } from "./runtime/settlement-policy";
import { buildTruthLedgerView } from "./truth-ledger";
import { getRatificationEnvDebugSnapshot } from "./env";
import { createDynamicTokenVerifierFromEnv, type DynamicTokenVerifier } from "./dynamic-auth";

const SESSION_HEADER = "x-day1-session-token";
const SESSION_COOKIE_NAME = "day1_session";
const CSRF_HEADER = "x-day1-csrf-token";
const DEVICE_HEADER = "x-day1-device-id";
const REQUEST_ID_HEADER = "x-request-id";
const CORRELATION_ID_HEADER = "x-correlation-id";
const IDEMPOTENCY_HEADER = "idempotency-key";
const SESSION_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const IDEMPOTENCY_TTL_MS = 1000 * 60 * 60 * 12;
const REGISTER_POLICY: RateLimitPolicy = { maxAttempts: 10, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000 };
const LOGIN_POLICY: RateLimitPolicy = { maxAttempts: 6, windowMs: 10 * 60 * 1000, blockMs: 10 * 60 * 1000 };
const SESSION_TOKEN_MAX_LENGTH = 256;
const PASSWORD_RESET_MIN_LENGTH = 8;
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const DEFAULT_CORS_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;
type SessionCookieSameSite = "strict" | "lax" | "none";

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseSessionCookieSameSite = (value: string | undefined): SessionCookieSameSite | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "strict" || normalized === "lax" || normalized === "none") {
    return normalized;
  }
  return null;
};

const resolveSessionCookiePolicy = () => {
  const isProduction = process.env.NODE_ENV === "production";
  const sameSite = parseSessionCookieSameSite(process.env.DAY1_SESSION_COOKIE_SAME_SITE) ?? (isProduction ? "none" : "strict");
  const secureDefault = isProduction || sameSite === "none";
  const secure = sameSite === "none" ? true : parseBooleanEnv(process.env.DAY1_SESSION_COOKIE_SECURE, secureDefault);
  const domain = process.env.DAY1_SESSION_COOKIE_DOMAIN?.trim() || undefined;
  return { sameSite, secure, domain };
};

const readSessionId = (raw: string | string[] | undefined) =>
  Array.isArray(raw) ? raw[0] : raw;

const getAllowedCorsOrigins = () => {
  const configured = process.env.DAY1_CORS_ALLOWED_ORIGINS?.trim();
  if (!configured) return DEFAULT_CORS_ALLOWED_ORIGINS;
  const parsed = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_CORS_ALLOWED_ORIGINS;
};

const resolvePlayerSymbol = (
  game: { playerSeats: { X: string; O: string | null } },
  userId: string
): "X" | "O" | null => {
  if (game.playerSeats.X === userId) return "X";
  if (game.playerSeats.O === userId) return "O";
  return null;
};

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const normalizeDisplayName = (displayName: string) => displayName.trim().slice(0, 40);
const hashPassword = (password: string, salt: string) =>
  scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
const normalizeDeviceId = (value: string | string[] | undefined) => {
  const raw = readSessionId(value)?.trim();
  if (!raw) return undefined;
  if (raw.length > 128) return undefined;
  return raw;
};

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32Encode = (input: Buffer) => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += base32Alphabet[(value << (5 - bits)) & 31];
  }
  return output;
};

const base32Decode = (secret: string) => {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/g, "")) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

const computeTotpCode = (secretBase32: string, forUnixSeconds: number) => {
  const counter = Math.floor(forUnixSeconds / TOTP_STEP_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = binaryCode % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, "0");
};

const isTotpCodeValid = (secretBase32: string, candidateCode: string, nowSeconds = Math.floor(Date.now() / 1000)) => {
  if (!/^\d{6}$/.test(candidateCode)) return false;
  const windows = [0, -1, 1];
  return windows.some((windowOffset) => {
    const expected = computeTotpCode(secretBase32, nowSeconds + windowOffset * TOTP_STEP_SECONDS);
    return expected === candidateCode;
  });
};

const parseCookies = (raw: string | undefined) => {
  if (!raw) return new Map<string, string>();
  const parsed = new Map<string, string>();
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k || rest.length === 0) continue;
    parsed.set(k, decodeURIComponent(rest.join("=")));
  }
  return parsed;
};

const resolveEncryptionKey = () =>
  scryptSync(
    process.env.DAY1_TOTP_ENCRYPTION_KEY ?? "day1-dev-only-encryption-key-change-me",
    "day1-totp-salt",
    32
  );

const encryptSecret = (plainText: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resolveEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
};

const decryptSecret = (encodedCiphertext: string) => {
  const [ivHex, tagHex, encryptedHex] = encodedCiphertext.split(":");
  if (!ivHex || !tagHex || !encryptedHex) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", resolveEncryptionKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
};

const toRateLimitKey = (prefix: string, ip: string, identifier?: string) =>
  identifier ? `${prefix}:${ip}:${identifier}` : `${prefix}:${ip}`;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const makeRequestHash = (payload: unknown) => createHash("sha256").update(stableJson(payload)).digest("hex");

const logStructured = (entry: Record<string, unknown>) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "ergo-games-day1-api",
      ...entry,
    })
  );
};

const registerRateLimitFailure = (
  adapter: ReturnType<typeof createRateLimiterAdapter>,
  keys: string[],
  policy: RateLimitPolicy
) => {
  for (const key of keys) adapter.registerFailure(key, policy);
};

const clearRateLimits = (adapter: ReturnType<typeof createRateLimiterAdapter>, keys: string[]) => {
  for (const key of keys) adapter.clear(key);
};

const describeRatificationReason = (reason: string | undefined) => {
  switch (reason) {
    case "NO_ELIGIBLE_EVENTS":
      return "No eligible off-chain events are waiting for ratification.";
    case "COOLDOWN_NOT_REACHED":
      return "Ratification cooldown window has not elapsed since last success.";
    case "ALREADY_RATIFIED_THIS_BLOCK":
      return "A ratification already succeeded in the current block height.";
    case "SERVER_WALLET_NOT_READY":
      return "Server wallet is not ready for ratification.";
    default:
      return reason ? "Ratification was not executed for the reported reason." : undefined;
  }
};

interface ApiCapabilityEnvelope {
  scaffold: true;
  capabilities: ProgressiveAccountCapabilities;
  authority: { authority: "day1-server-user-id"; userId: string };
}

const deriveAccountCapabilities = (profile: {
  walletStatus: string;
  walletAddress?: string;
}): ProgressiveAccountCapabilities => {
  const hasWallet = profile.walletStatus !== "unbound" && Boolean(profile.walletAddress?.trim());
  return buildProgressiveAccountCapabilities({
    sessionActive: true,
    walletBound: hasWallet,
    rewardsWalletRequirement: "required",
    wageringWalletRequirement: "required",
  });
};

interface CreateDay1AppOptions {
  enableRatificationScheduler?: boolean;
  dynamicTokenVerifier?: DynamicTokenVerifier | null;
}

export const createDay1App = (store = new Day1Store(), options: CreateDay1AppOptions = {}) => {
  const app = express();
  const allowedCorsOrigins = new Set(getAllowedCorsOrigins());
  const sessionCookiePolicy = resolveSessionCookiePolicy();
  const walletManager = new ServerWalletManager();
  const ratificationService = new RatificationService(store, walletManager);
  const rateLimiter = createRateLimiterAdapter(store);
  const sessionService = new StoreBackedGameSessionService(store);
  const rewardPolicy = new Day1RewardPolicy();
  const settlementPolicy = new Day1SettlementPolicy();
  const enableRatificationScheduler = options.enableRatificationScheduler ?? true;
  const dynamicTokenVerifier = options.dynamicTokenVerifier ?? createDynamicTokenVerifierFromEnv();
  if (enableRatificationScheduler) ratificationService.start();
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow non-browser clients (tests/curl) that do not send an Origin header.
        if (!origin) return callback(null, true);
        return callback(null, allowedCorsOrigins.has(origin));
      },
      credentials: true,
    })
  );
  app.use(express.json());
  app.set("trust proxy", true);
  app.use((req, res, next) => {
    const requestId = readSessionId(req.headers[REQUEST_ID_HEADER])?.trim() || randomUUID();
    const correlationId = readSessionId(req.headers[CORRELATION_ID_HEADER])?.trim() || requestId;
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.locals.correlationId = correlationId;
    res.locals.startedAt = startedAt;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.on("finish", () => {
      const endpointKey = `${req.method} ${req.path}`;
      const latencyMs = Date.now() - startedAt;
      const isError = res.statusCode >= 500;
      if (
        req.path.startsWith("/api/auth/") ||
        req.path.startsWith("/api/game/") ||
        req.path.startsWith("/api/ratification/") ||
        req.path === "/api/onchain/intent/create" ||
        req.path === "/api/wallet/bind"
      ) {
        store.recordEndpointMetric({ endpointKey, latencyMs, isError: res.statusCode >= 400 });
      }
      logStructured({
        level: isError ? "error" : "info",
        event: "http_request",
        requestId,
        correlationId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        latencyMs,
        ip: req.ip,
      });
    });
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  const readSessionToken = (req: express.Request) => {
    const headerToken = readSessionId(req.headers[SESSION_HEADER]);
    const normalizedHeaderToken = headerToken?.trim();
    if (normalizedHeaderToken) return { token: normalizedHeaderToken, authMethod: "header" as const };
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies.get(SESSION_COOKIE_NAME)?.trim();
    if (cookieToken) return { token: cookieToken, authMethod: "cookie" as const };
    return null;
  };

  const logSecurityEvent = (
    req: express.Request,
    event: {
      eventType: string;
      userId?: string;
      sessionId?: string;
      outcome: "SUCCESS" | "FAILURE" | "INFO";
      metadata?: Record<string, unknown>;
    }
  ) => {
    const requestId = readSessionId(req.headers[REQUEST_ID_HEADER])?.trim();
    const correlationId = readSessionId(req.headers[CORRELATION_ID_HEADER])?.trim();
    store.logSecurityEvent({
      eventType: event.eventType,
      userId: event.userId,
      sessionId: event.sessionId,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      outcome: event.outcome,
      metadata: {
        ...(event.metadata ?? {}),
        requestId: requestId || undefined,
        correlationId: correlationId || undefined,
      },
    });
  };

  const writeSessionCookie = (res: express.Response, token: string) => {
    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: sessionCookiePolicy.sameSite,
      secure: sessionCookiePolicy.secure,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      path: "/",
      domain: sessionCookiePolicy.domain,
      priority: "high",
    });
  };

  const clearSessionCookie = (res: express.Response) => {
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: sessionCookiePolicy.sameSite,
      secure: sessionCookiePolicy.secure,
      path: "/",
      domain: sessionCookiePolicy.domain,
    });
  };

  const requireAuth = (req: express.Request, res: express.Response) => {
    store.purgeExpiredSessions();
    const tokenResult = readSessionToken(req);
    if (!tokenResult) {
      res.status(401).json({ error: "MISSING_SESSION", sessionHeader: SESSION_HEADER });
      return null;
    }
    const token = tokenResult.token;
    if (token.length > SESSION_TOKEN_MAX_LENGTH) {
      clearSessionCookie(res);
      res.status(401).json({ error: "SESSION_NOT_FOUND", sessionHeader: SESSION_HEADER });
      return null;
    }
    const sessionAndProfile = store.getSessionAndProfileByToken(token);
    if (!sessionAndProfile) {
      clearSessionCookie(res);
      res.status(401).json({ error: "SESSION_NOT_FOUND", sessionHeader: SESSION_HEADER });
      return null;
    }
    return { ...sessionAndProfile, sessionToken: token, authMethod: tokenResult.authMethod };
  };

  const requireCsrfForCookieAuthMutation = (
    req: express.Request,
    res: express.Response,
    auth: { session: { sessionId: string; userId: string }; authMethod: "header" | "cookie" }
  ) => {
    if (auth.authMethod !== "cookie") return true;
    const csrfToken = readSessionId(req.headers[CSRF_HEADER])?.trim();
    if (!csrfToken || !store.isCsrfTokenValid(auth.session.sessionId, csrfToken)) {
      logSecurityEvent(req, {
        eventType: "CSRF_VALIDATION",
        userId: auth.session.userId,
        sessionId: auth.session.sessionId,
        outcome: "FAILURE",
        metadata: { reason: "TOKEN_MISSING_OR_INVALID" },
      });
      res.status(403).json({ error: "CSRF_INVALID", csrfHeader: CSRF_HEADER });
      return false;
    }
    return true;
  };

  const requireAuthForMutation = (req: express.Request, res: express.Response) => {
    const auth = requireAuth(req, res);
    if (!auth) return null;
    if (!requireCsrfForCookieAuthMutation(req, res, auth)) return null;
    return auth;
  };

  const resolveAuthIfPresent = (req: express.Request) => {
    store.purgeExpiredSessions();
    const tokenResult = readSessionToken(req);
    if (!tokenResult) return null;
    if (tokenResult.token.length > SESSION_TOKEN_MAX_LENGTH) return null;
    const sessionAndProfile = store.getSessionAndProfileByToken(tokenResult.token);
    if (!sessionAndProfile) return null;
    return { ...sessionAndProfile, sessionToken: tokenResult.token, authMethod: tokenResult.authMethod };
  };

  const rejectIfBlocked = (
    req: express.Request,
    res: express.Response,
    key: string,
    policy: RateLimitPolicy
  ) => {
    const status = rateLimiter.getStatus(key, policy);
    if (!status.blocked) return false;
    res.status(429).json({
      error: "RATE_LIMITED",
      retryAfterSeconds: Math.ceil(status.retryAfterMs / 1000),
      note: "Temporary throttle to reduce brute-force risk.",
    });
    return true;
  };

  const withIdempotency = (
    req: express.Request,
    res: express.Response,
    input: { scope: string; principalKey: string },
    execute: () => void | Promise<void>
  ) => {
    const rawKey = readSessionId(req.headers[IDEMPOTENCY_HEADER])?.trim();
    if (!rawKey) {
      execute();
      return;
    }
    if (rawKey.length > 200) {
      res.status(400).json({ error: "IDEMPOTENCY_KEY_INVALID" });
      return;
    }
    const requestHash = makeRequestHash({
      method: req.method,
      path: req.path,
      body: req.body ?? {},
      params: req.params ?? {},
      query: req.query ?? {},
      principalKey: input.principalKey,
    });
    const lookup = store.lookupIdempotency(input.principalKey, input.scope, rawKey, requestHash);
    if (lookup.state === "replay") {
      res.setHeader("x-day1-idempotent-replay", "true");
      res.status(lookup.replay.statusCode).json(lookup.replay.body);
      return;
    }
    if (lookup.state === "conflict") {
      res.status(409).json({ error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" });
      return;
    }
    if (lookup.state === "pending") {
      res.status(409).json({ error: "IDEMPOTENCY_IN_PROGRESS" });
      return;
    }
    const reserved = store.reserveIdempotencyKey({
      principalKey: input.principalKey,
      scope: input.scope,
      idempotencyKey: rawKey,
      requestHash,
      ttlMs: IDEMPOTENCY_TTL_MS,
    });
    if (!reserved) {
      const retry = store.lookupIdempotency(input.principalKey, input.scope, rawKey, requestHash);
      if (retry.state === "replay") {
        res.setHeader("x-day1-idempotent-replay", "true");
        res.status(retry.replay.statusCode).json(retry.replay.body);
        return;
      }
      if (retry.state === "conflict") {
        res.status(409).json({ error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" });
        return;
      }
      res.status(409).json({ error: "IDEMPOTENCY_IN_PROGRESS" });
      return;
    }
    const originalJson = res.json.bind(res);
    let completed = false;
    res.json = ((body: unknown) => {
      if (completed) return originalJson(body);
      completed = true;
      store.completeIdempotencyKey({
        principalKey: input.principalKey,
        scope: input.scope,
        idempotencyKey: rawKey,
        requestHash,
        statusCode: res.statusCode || 200,
        body,
      });
      return originalJson(body);
    }) as express.Response["json"];
    Promise.resolve(execute()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "IDEMPOTENCY_EXECUTION_FAILED";
      if (!res.headersSent) res.status(500).json({ error: "INTERNAL_ERROR", message });
    });
  };

  const buildGamePayload = (game: GameRecord, userId: string) => {
    const engine = getGameEngine(game.gameType);
    const status = engine ? engine.getStatus(game) : { kind: "open" as const };
    const playerSymbol = resolvePlayerSymbol(game, userId);
    const rewardSnapshot = store.getRewards(userId);
    const winnerUserId =
      status.kind === "won" ? (status.winner === "X" ? game.playerSeats.X : game.playerSeats.O) : null;

    return {
      scaffold: true,
      game,
      status,
      playerSymbol,
      rewardSnapshot,
      completion:
        status.kind === "won" || status.kind === "drawn"
          ? {
              finished: true,
              kind: status.kind,
              winnerSymbol: status.kind === "won" ? status.winner : null,
              winnerUserId,
            }
          : {
              finished: false,
              kind: "ongoing",
              winnerSymbol: null,
              winnerUserId: null,
            },
    };
  };

  const buildAuthSuccessPayload = (
    session: { sessionId: string; userId: string; createdAt: string; expiresAt: string; deviceId?: string; mfaVerifiedAt?: string },
    profile: { userId: string; displayName: string; email: string; walletStatus: string; gamesPlayed: number; wins: number; walletAddress?: string; mfaEnabled?: boolean },
    csrfToken: string,
    sessionToken: string
  ) => {
    const capabilities = deriveAccountCapabilities(profile);
    return {
      scaffold: true as const,
      session,
      sessionToken,
      profile,
      capabilities,
      authority: { authority: "day1-server-user-id" as const, userId: session.userId },
      sessionHeader: SESSION_HEADER,
      sessionCookie: SESSION_COOKIE_NAME,
      csrfHeader: CSRF_HEADER,
      csrfToken,
      deviceHeader: DEVICE_HEADER,
    };
  };

  const buildCapabilityEnvelope = (auth: {
    session: { userId: string };
    profile: { walletStatus: string; walletAddress?: string };
  }): ApiCapabilityEnvelope => ({
    scaffold: true,
    capabilities: deriveAccountCapabilities(auth.profile),
    authority: { authority: "day1-server-user-id", userId: auth.session.userId },
  });

  const requireCapabilityForWalletBoundAction = (
    res: express.Response,
    auth: { session: { userId: string }; profile: { walletStatus: string; walletAddress?: string } },
    capability: "canReceiveRewards" | "canWager"
  ) => {
    const envelope = buildCapabilityEnvelope(auth);
    const eligible =
      capability === "canReceiveRewards"
        ? envelope.capabilities.layers.rewards.eligible
        : envelope.capabilities.layers.wagering.eligible;
    if (eligible) return true;
    res.status(403).json({
      error: "CAPABILITY_REQUIRED",
      capability,
      ...envelope,
      note:
        capability === "canReceiveRewards"
          ? "Bind a wallet to receive rewards."
          : "Bind a wallet before creating wager/on-chain intents.",
    });
    return false;
  };

  const createGuestSessionPayload = (
    req: express.Request,
    res: express.Response,
    displayNameRaw: string,
    authMode: "guest" | "sync_bootstrap" | "dynamic_compatibility",
    emailHintRaw?: string
  ) => {
    const displayName = normalizeDisplayName(displayNameRaw) || "Guest Player";
    const emailHint = normalizeEmail(String(emailHintRaw ?? ""));
    const hintedAccount = emailHint && emailHint.includes("@") ? store.getAccountCredentialByEmail(emailHint) : null;
    let profile = hintedAccount ? store.getProfile(hintedAccount.userId) : null;
    if (!profile) {
      const email = emailHint && emailHint.includes("@") ? emailHint : `guest-${randomUUID().slice(0, 10)}@local.day1`;
      const passwordSalt = randomUUID().replaceAll("-", "");
      profile = store.createAccount({
        email,
        displayName,
        passwordSalt,
        passwordHash: hashPassword(randomUUID().replaceAll("-", ""), passwordSalt),
      });
    }
    if (!profile) {
      res.status(500).json({ error: "GUEST_BOOTSTRAP_FAILED" });
      return null;
    }
    const { session, sessionToken, csrfToken } = store.createSessionForUser(profile.userId, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      deviceId: normalizeDeviceId(req.headers[DEVICE_HEADER]),
    });
    writeSessionCookie(res, sessionToken);
    logSecurityEvent(req, {
      eventType:
        authMode === "guest"
          ? "AUTH_GUEST_LOGIN"
          : authMode === "dynamic_compatibility"
            ? "AUTH_DYNAMIC_COMPAT"
            : "AUTH_SYNC",
      userId: profile.userId,
      sessionId: session.sessionId,
      outcome: "SUCCESS",
    });
    return { ...buildAuthSuccessPayload(session, profile, csrfToken, sessionToken), authMode };
  };

  app.get("/api/health", (_req, res) => {
    const walletStatus = walletManager.getStatus();
    const dbReadiness = store.checkDatabaseReadiness();
    const ratificationSchedule = ratificationService.getSchedule();
    const ratificationCheckpoint = ratificationService.getCheckpoint();
    const ratificationAdapter = ratificationService.getAdapterInfo();
    const rateLimitReadiness = rateLimiter.readiness();
    res.json({
      ok: dbReadiness.ready,
      mode: "day1-primetime-foundation",
      notes: "No-wager game foundation with local-first security and persistence.",
      ratification: {
        schedule: ratificationSchedule,
        checkpoint: ratificationCheckpoint,
        adapter: ratificationAdapter,
      },
      serverWallet: {
        mode: walletStatus.mode,
        network: walletStatus.network,
        ready: walletStatus.ready,
      },
      dependencies: {
        database: dbReadiness,
        rateLimiter: rateLimitReadiness,
      },
    });
  });

  app.get("/api/health/readiness", (_req, res) => {
    const walletStatus = walletManager.getStatus();
    const dbReadiness = store.checkDatabaseReadiness();
    const rateLimitReadiness = rateLimiter.readiness();
    const ratificationSchedule = ratificationService.getSchedule();
    const ratificationCheckpoint = ratificationService.getCheckpoint();
    const ratificationAdapter = ratificationService.getAdapterInfo();
    const hasSubmitEndpoint = Boolean(process.env.DAY1_ERGO_NODE_URL);
    const ergoConfigOk = ratificationAdapter.mode !== "ergo" || (walletStatus.ready && hasSubmitEndpoint);
    const ready = dbReadiness.ready && walletStatus.ready && ergoConfigOk;
    res.status(ready ? 200 : 503).json({
      ready,
      dependencies: {
        database: dbReadiness,
        wallet: {
          ready: walletStatus.ready,
          mode: walletStatus.mode,
          network: walletStatus.network,
          reason: walletStatus.reason,
        },
        ratification: {
          ready: walletStatus.ready && ergoConfigOk,
          schedule: ratificationSchedule,
          checkpoint: ratificationCheckpoint,
          adapter: ratificationAdapter,
        },
        rateLimiter: rateLimitReadiness,
      },
    });
  });

  app.get("/api/health/env", (_req, res) => {
    res.json({
      scaffold: true,
      env: getRatificationEnvDebugSnapshot(),
    });
  });

  app.post("/api/auth/register", (req, res) => {
    const email = normalizeEmail(String(req.body?.email ?? ""));
    const displayName = normalizeDisplayName(String(req.body?.displayName ?? ""));
    const password = String(req.body?.password ?? "");
    const registerRateKeys = [
      toRateLimitKey("register", req.ip ?? "unknown"),
      toRateLimitKey("register-email", req.ip ?? "unknown", email || "unknown"),
    ];

    for (const key of registerRateKeys) {
      if (rejectIfBlocked(req, res, key, REGISTER_POLICY)) return;
    }
    if (!email || !email.includes("@")) {
      registerRateLimitFailure(rateLimiter, registerRateKeys, REGISTER_POLICY);
      res.status(400).json({ error: "INVALID_EMAIL" });
      return;
    }
    if (!displayName) {
      registerRateLimitFailure(rateLimiter, registerRateKeys, REGISTER_POLICY);
      res.status(400).json({ error: "DISPLAY_NAME_REQUIRED" });
      return;
    }
    if (password.length < 8) {
      registerRateLimitFailure(rateLimiter, registerRateKeys, REGISTER_POLICY);
      res.status(400).json({ error: "WEAK_PASSWORD", note: "Password must be at least 8 characters." });
      return;
    }

    const passwordSalt = randomUUID().replaceAll("-", "");
    const profile = store.createAccount({
      email,
      displayName,
      passwordSalt,
      passwordHash: hashPassword(password, passwordSalt),
    });

    if (!profile) {
      registerRateLimitFailure(rateLimiter, registerRateKeys, REGISTER_POLICY);
      res.status(409).json({ error: "EMAIL_ALREADY_REGISTERED" });
      return;
    }

    clearRateLimits(rateLimiter, registerRateKeys);
    const { session, sessionToken, csrfToken } = store.createSessionForUser(profile.userId, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      deviceId: normalizeDeviceId(req.headers[DEVICE_HEADER]),
    });
    writeSessionCookie(res, sessionToken);
    logSecurityEvent(req, { eventType: "AUTH_REGISTER", userId: profile.userId, sessionId: session.sessionId, outcome: "SUCCESS" });
    res.status(201).json(buildAuthSuccessPayload(session, profile, csrfToken, sessionToken));
  });

  app.post("/api/auth/login", (req, res) => {
    const email = normalizeEmail(String(req.body?.email ?? ""));
    const password = String(req.body?.password ?? "");
    const loginRateKeys = [
      toRateLimitKey("login", req.ip ?? "unknown"),
      toRateLimitKey("login-email", req.ip ?? "unknown", email || "unknown"),
    ];
    for (const key of loginRateKeys) {
      if (rejectIfBlocked(req, res, key, LOGIN_POLICY)) return;
    }

    store.purgeExpiredSessions();
    const account = store.getAccountCredentialByEmail(email);
    if (!account) {
      registerRateLimitFailure(rateLimiter, loginRateKeys, LOGIN_POLICY);
      logSecurityEvent(req, { eventType: "AUTH_LOGIN", outcome: "FAILURE", metadata: { reason: "ACCOUNT_NOT_FOUND", email } });
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    const candidateHash = hashPassword(password, account.passwordSalt);
    const candidateBuffer = Buffer.from(candidateHash);
    const storedBuffer = Buffer.from(account.passwordHash);
    const isPasswordValid =
      candidateBuffer.length === storedBuffer.length && timingSafeEqual(candidateBuffer, storedBuffer);
    if (!isPasswordValid) {
      registerRateLimitFailure(rateLimiter, loginRateKeys, LOGIN_POLICY);
      logSecurityEvent(req, { eventType: "AUTH_LOGIN", userId: account.userId, outcome: "FAILURE", metadata: { reason: "BAD_PASSWORD" } });
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    const deviceId = normalizeDeviceId(req.headers[DEVICE_HEADER]);
    const trustedDevice = deviceId ? store.isTrustedDevice(account.userId, deviceId) : false;
    const mfaCode = String(req.body?.mfaCode ?? "").trim();
    const rememberDevice = Boolean(req.body?.rememberDevice);
    let mfaVerifiedAt: string | undefined;
    if (account.mfaEnabled) {
      if (!trustedDevice && !mfaCode) {
        logSecurityEvent(req, {
          eventType: "AUTH_MFA_CHALLENGE",
          userId: account.userId,
          outcome: "INFO",
          metadata: { reason: "MFA_REQUIRED", deviceId: deviceId ?? null },
        });
        res.status(401).json({ error: "MFA_REQUIRED", mfaMethod: "TOTP", deviceHeader: DEVICE_HEADER });
        return;
      }
      if (!trustedDevice) {
        const secret = account.totpSecretCiphertext ? decryptSecret(account.totpSecretCiphertext) : null;
        if (!secret || !isTotpCodeValid(secret, mfaCode)) {
          logSecurityEvent(req, {
            eventType: "AUTH_MFA_VERIFY",
            userId: account.userId,
            outcome: "FAILURE",
            metadata: { reason: "INVALID_TOTP" },
          });
          res.status(401).json({ error: "MFA_INVALID" });
          return;
        }
        mfaVerifiedAt = new Date().toISOString();
        if (rememberDevice && deviceId) {
          store.upsertTrustedDevice(account.userId, deviceId, String(req.body?.deviceLabel ?? "Trusted device"));
        }
      } else {
        mfaVerifiedAt = new Date().toISOString();
      }
    }

    clearRateLimits(rateLimiter, loginRateKeys);
    const { session, sessionToken, csrfToken } = store.createSessionForUser(account.userId, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      deviceId,
      mfaVerifiedAt,
    });
    writeSessionCookie(res, sessionToken);
    const profile = store.getProfile(account.userId);
    if (!profile) {
      res.status(500).json({ error: "PROFILE_NOT_FOUND" });
      return;
    }

    logSecurityEvent(req, {
      eventType: "AUTH_LOGIN",
      userId: account.userId,
      sessionId: session.sessionId,
      outcome: "SUCCESS",
      metadata: { mfaEnabled: account.mfaEnabled, trustedDevice },
    });
    res.json(buildAuthSuccessPayload(session, profile, csrfToken, sessionToken));
  });

  app.post("/api/auth/dynamic/login", async (req, res) => {
    const authToken = String(req.body?.authToken ?? "").trim();
    if (!authToken) {
      res.status(400).json({ error: "DYNAMIC_AUTH_TOKEN_REQUIRED" });
      return;
    }
    if (!dynamicTokenVerifier) {
      res.status(503).json({
        error: "DYNAMIC_AUTH_NOT_CONFIGURED",
        note: "Set DAY1_DYNAMIC_AUTH_ENABLED plus issuer/audience/JWKS env vars to enable Dynamic login.",
      });
      return;
    }

    let claims: Awaited<ReturnType<DynamicTokenVerifier>>;
    try {
      claims = await dynamicTokenVerifier(authToken);
    } catch {
      logSecurityEvent(req, {
        eventType: "AUTH_DYNAMIC_LOGIN",
        outcome: "FAILURE",
        metadata: { reason: "TOKEN_VERIFY_FAILED" },
      });
      res.status(401).json({ error: "DYNAMIC_TOKEN_INVALID" });
      return;
    }

    const normalizeOptionalEmail = (candidate: unknown) => {
      const value = normalizeEmail(String(candidate ?? ""));
      return value && value.includes("@") ? value : undefined;
    };
    const displayNameCandidate = normalizeDisplayName(
      String(req.body?.displayName ?? claims.displayName ?? "Dynamic Player")
    );
    const currentAuth = resolveAuthIfPresent(req);
    const linked = store.getExternalIdentity("dynamic", claims.subject);
    let userId = currentAuth?.session.userId ?? linked?.userId;
    if (currentAuth?.session.userId && linked?.userId && linked.userId !== currentAuth.session.userId) {
      logSecurityEvent(req, {
        eventType: "AUTH_DYNAMIC_LOGIN",
        userId: currentAuth.session.userId,
        sessionId: currentAuth.session.sessionId,
        outcome: "FAILURE",
        metadata: {
          reason: "IDENTITY_CONFLICT",
          linkedUserId: linked.userId,
          sessionUserId: currentAuth.session.userId,
        },
      });
      res.status(409).json({
        error: "DYNAMIC_IDENTITY_CONFLICT",
        note: "Dynamic identity is already linked to a different Day1 account.",
      });
      return;
    }
    const dynamicEmail = normalizeOptionalEmail(claims.email) ?? normalizeOptionalEmail(req.body?.email);
    if (!userId && dynamicEmail) {
      userId = store.getAccountCredentialByEmail(dynamicEmail)?.userId;
    }
    if (!userId) {
      const fallbackEmail = dynamicEmail ?? `dynamic-${createHash("sha256").update(claims.subject).digest("hex").slice(0, 20)}@dynamic.local`;
      const passwordSalt = randomUUID().replaceAll("-", "");
      const created = store.createAccount({
        email: fallbackEmail,
        displayName: displayNameCandidate || "Dynamic Player",
        passwordSalt,
        passwordHash: hashPassword(randomUUID().replaceAll("-", ""), passwordSalt),
      });
      userId = created?.userId ?? store.getAccountCredentialByEmail(fallbackEmail)?.userId;
    }
    if (!userId) {
      res.status(500).json({ error: "DYNAMIC_ACCOUNT_LINK_FAILED" });
      return;
    }

    store.upsertExternalIdentity({
      provider: "dynamic",
      subject: claims.subject,
      userId,
      emailAtLink: dynamicEmail,
      displayNameAtLink: displayNameCandidate || undefined,
    });
    const profile = store.getProfile(userId);
    if (!profile) {
      res.status(500).json({ error: "PROFILE_NOT_FOUND" });
      return;
    }
    const { session, sessionToken, csrfToken } = store.createSessionForUser(userId, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      deviceId: normalizeDeviceId(req.headers[DEVICE_HEADER]),
    });
    writeSessionCookie(res, sessionToken);
    logSecurityEvent(req, {
      eventType: "AUTH_DYNAMIC_LOGIN",
      userId,
      sessionId: session.sessionId,
      outcome: "SUCCESS",
      metadata: { emailVerified: claims.emailVerified },
    });
    res.json({
      ...buildAuthSuccessPayload(session, profile, csrfToken, sessionToken),
      authMode: "dynamic",
    });
  });

  app.post("/api/auth/guest", (req, res) => {
    const payload = createGuestSessionPayload(req, res, String(req.body?.displayName ?? "Guest Player"), "guest");
    if (!payload) return;
    res.status(201).json(payload);
  });

  app.post("/api/auth/sync", (req, res) => {
    const payload = createGuestSessionPayload(
      req,
      res,
      String(req.body?.displayName ?? "Guest Player"),
      "dynamic_compatibility",
      String(req.body?.email ?? "")
    );
    if (!payload) return;
    res.status(201).json(payload);
  });

  app.get("/api/auth/session", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const csrfToken = store.rotateCsrfToken(auth.session.sessionId);
    const capabilityEnvelope = buildCapabilityEnvelope(auth);
    res.json({
      scaffold: true,
      active: true,
      session: auth.session,
      profile: auth.profile,
      capabilities: capabilityEnvelope.capabilities,
      authority: capabilityEnvelope.authority,
      csrfToken,
      csrfHeader: CSRF_HEADER,
    });
  });

  app.get("/api/me/capabilities", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json(buildCapabilityEnvelope(auth));
  });

  app.post("/api/auth/csrf", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!requireCsrfForCookieAuthMutation(req, res, auth)) return;
    const csrfToken = store.rotateCsrfToken(auth.session.sessionId);
    if (!csrfToken) {
      res.status(404).json({ error: "SESSION_NOT_FOUND" });
      return;
    }
    res.json({ scaffold: true, csrfToken, csrfHeader: CSRF_HEADER });
  });

  app.post("/api/auth/recovery/request", (req, res) => {
    const email = normalizeEmail(String(req.body?.email ?? ""));
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "INVALID_EMAIL" });
      return;
    }
    const tokenResult = store.createPasswordResetToken(email, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    logSecurityEvent(req, {
      eventType: "AUTH_RECOVERY_REQUEST",
      userId: tokenResult?.userId,
      outcome: "INFO",
      metadata: { emailHint: email.slice(0, 3) },
    });
    res.status(202).json({
      scaffold: true,
      accepted: true,
      // Dev-only token preview to enable local testing before mail integration exists.
      resetTokenPreview: process.env.NODE_ENV === "production" ? undefined : tokenResult?.token,
      expiresAt: tokenResult?.expiresAt,
    });
  });

  app.post("/api/auth/recovery/reset", (req, res) => {
    const token = String(req.body?.token ?? "").trim();
    const newPassword = String(req.body?.newPassword ?? "");
    if (!token) {
      res.status(400).json({ error: "TOKEN_REQUIRED" });
      return;
    }
    if (newPassword.length < PASSWORD_RESET_MIN_LENGTH) {
      res.status(400).json({ error: "WEAK_PASSWORD", note: "Password must be at least 8 characters." });
      return;
    }
    const passwordSalt = randomUUID().replaceAll("-", "");
    const result = store.consumePasswordResetToken(token, hashPassword(newPassword, passwordSalt), passwordSalt);
    if (!result.ok) {
      logSecurityEvent(req, {
        eventType: "AUTH_RECOVERY_RESET",
        outcome: "FAILURE",
        metadata: { reason: result.reason },
      });
      res.status(400).json({ error: result.reason });
      return;
    }
    logSecurityEvent(req, {
      eventType: "AUTH_RECOVERY_RESET",
      userId: result.userId,
      outcome: "SUCCESS",
    });
    res.json({ scaffold: true, reset: true });
  });

  app.post("/api/auth/signout", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: "auth:signout", principalKey: auth.session.userId }, () => {
      const removed = store.removeSessionByToken(auth.sessionToken);
      clearSessionCookie(res);
      if (!removed) {
        res.status(401).json({ error: "SESSION_NOT_FOUND", sessionHeader: SESSION_HEADER });
        return;
      }
      logSecurityEvent(req, {
        eventType: "AUTH_SIGNOUT",
        userId: auth.session.userId,
        sessionId: auth.session.sessionId,
        outcome: "SUCCESS",
      });
      res.json({ scaffold: true, signedOut: true, sessionId: auth.session.sessionId });
    });
  });

  app.get("/api/me/profile", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({ scaffold: true, profile: auth.profile });
  });

  app.get("/api/me/security-state", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const securityState = store.getAccountSecurityState(auth.session.userId);
    if (!securityState) {
      res.status(404).json({ error: "PROFILE_NOT_FOUND" });
      return;
    }
    res.json({ scaffold: true, securityState });
  });

  app.post("/api/auth/mfa/totp/enroll/start", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    const secret = base32Encode(randomBytes(20));
    const secretCiphertext = encryptSecret(secret);
    const enrollment = store.createTotpEnrollment(auth.session.userId, secretCiphertext);
    const issuer = encodeURIComponent("ErgoGamesDay1");
    const label = encodeURIComponent(auth.profile.email);
    const otpauthUri = `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;
    logSecurityEvent(req, {
      eventType: "AUTH_MFA_ENROLL_START",
      userId: auth.session.userId,
      sessionId: auth.session.sessionId,
      outcome: "INFO",
      metadata: { enrollmentId: enrollment.enrollmentId },
    });
    res.json({
      scaffold: true,
      enrollmentId: enrollment.enrollmentId,
      expiresAt: enrollment.expiresAt,
      secret,
      otpauthUri,
    });
  });

  app.post("/api/auth/mfa/totp/enroll/verify", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    const code = String(req.body?.code ?? "").trim();
    const pending = store.getPendingTotpEnrollment(auth.session.userId);
    if (!pending) {
      res.status(400).json({ error: "MFA_ENROLLMENT_NOT_FOUND" });
      return;
    }
    const secret = decryptSecret(pending.secretCiphertext);
    if (!secret || !isTotpCodeValid(secret, code)) {
      logSecurityEvent(req, {
        eventType: "AUTH_MFA_ENROLL_VERIFY",
        userId: auth.session.userId,
        sessionId: auth.session.sessionId,
        outcome: "FAILURE",
      });
      res.status(400).json({ error: "MFA_CODE_INVALID" });
      return;
    }
    store.confirmTotpEnrollment(auth.session.userId, pending.secretCiphertext);
    logSecurityEvent(req, {
      eventType: "AUTH_MFA_ENROLL_VERIFY",
      userId: auth.session.userId,
      sessionId: auth.session.sessionId,
      outcome: "SUCCESS",
    });
    res.json({ scaffold: true, mfaEnabled: true });
  });

  app.post("/api/auth/mfa/totp/disable", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    const account = store.getAccountCredentialByEmail(auth.profile.email);
    const code = String(req.body?.code ?? "").trim();
    if (!account?.mfaEnabled || !account.totpSecretCiphertext) {
      res.status(400).json({ error: "MFA_NOT_ENABLED" });
      return;
    }
    const secret = decryptSecret(account.totpSecretCiphertext);
    if (!secret || !isTotpCodeValid(secret, code)) {
      res.status(400).json({ error: "MFA_CODE_INVALID" });
      return;
    }
    store.disableTotpForUser(auth.session.userId);
    logSecurityEvent(req, {
      eventType: "AUTH_MFA_DISABLED",
      userId: auth.session.userId,
      sessionId: auth.session.sessionId,
      outcome: "SUCCESS",
    });
    res.json({ scaffold: true, mfaEnabled: false });
  });

  app.get("/api/security/devices", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({ scaffold: true, devices: store.listTrustedDevices(auth.session.userId) });
  });

  app.post("/api/security/devices/trust", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    const deviceId = String(req.body?.deviceId ?? normalizeDeviceId(req.headers[DEVICE_HEADER]) ?? "").trim();
    if (!deviceId) {
      res.status(400).json({ error: "DEVICE_ID_REQUIRED", deviceHeader: DEVICE_HEADER });
      return;
    }
    store.upsertTrustedDevice(auth.session.userId, deviceId, String(req.body?.label ?? "Trusted device"));
    res.status(201).json({ scaffold: true, trusted: true, deviceId });
  });

  app.post("/api/security/devices/:deviceId/revoke", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    const revoked = store.revokeTrustedDevice(auth.session.userId, req.params.deviceId);
    if (!revoked) {
      res.status(404).json({ error: "DEVICE_NOT_FOUND" });
      return;
    }
    res.json({ scaffold: true, revoked: true, deviceId: req.params.deviceId });
  });

  app.get("/api/security/sessions", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({ scaffold: true, sessions: store.listSessionsForUser(auth.session.userId) });
  });

  app.post("/api/security/sessions/:sessionId/revoke", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: `security:session:revoke:${req.params.sessionId}`, principalKey: auth.session.userId }, () => {
      const revoked = store.revokeSessionById(auth.session.userId, req.params.sessionId);
      if (req.params.sessionId === auth.session.sessionId) {
        clearSessionCookie(res);
      }
      res.json({
        scaffold: true,
        revoked,
        alreadyRevoked: !revoked,
        sessionId: req.params.sessionId,
      });
    });
  });

  app.get("/api/security/events", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 30) || 30));
    res.json({ scaffold: true, events: store.listSecurityEventsForUser(auth.session.userId, limit) });
  });

  app.get("/api/security/metrics", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({
      scaffold: true,
      metrics: {
        security: store.getSecurityMetricSnapshot(),
        endpoints: store.getEndpointMetricSnapshot(),
      },
    });
  });

  app.post("/api/wallet/bind", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: "wallet:bind", principalKey: auth.session.userId }, () => {
      const walletAddress = String(req.body?.walletAddress ?? "").trim();
      if (!walletAddress) {
        res.status(400).json({ error: "WALLET_REQUIRED" });
        return;
      }
      const profile = store.bindWallet(auth.session.userId, walletAddress);
      if (!profile) {
        res.status(404).json({ error: "PROFILE_NOT_FOUND" });
        return;
      }
      res.json({
        scaffold: true,
        walletBinding: {
          status: "bound_stub",
          network: `erg-${walletManager.getNetwork()}-placeholder`,
        },
        profile,
      });
    });
  });

  app.get("/api/games", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const filter = String(req.query.status ?? "all");
    const games = store.listGames().filter((game) => {
      if (filter === "open") return game.playerSeats.O === null;
      if (filter === "active") return game.status.kind === "ongoing";
      if (filter === "completed") return game.status.kind === "won" || game.status.kind === "drawn";
      return true;
    });
    res.json({ scaffold: true, games, requestedBy: auth.session.userId });
  });

  app.get("/api/game-types", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({ scaffold: true, gameTypes: listGameMetadata(), requestedBy: auth.session.userId });
  });

  app.get("/api/players/recent", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
    res.json({
      scaffold: true,
      players: store.listRecentPlayers(limit),
      requestedBy: auth.session.userId,
    });
  });

  app.get("/api/leaderboard", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
    res.json({
      scaffold: true,
      leaderboard: store.getLeaderboard(limit),
      requestedBy: auth.session.userId,
      note: "No-wager progression leaderboard from local game outcomes.",
    });
  });

  app.post("/api/game/create", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: "game:create", principalKey: auth.session.userId }, () => {
      const requestedType = (req.body as ApiCreateGameRequest | undefined)?.gameType;
      const gameType: GameType = requestedType ?? DEFAULT_GAME_TYPE;
      const engine = getGameEngine(gameType);
      if (!engine) {
        res.status(400).json({ error: "GAME_TYPE_UNSUPPORTED", supportedGameTypes: listGameMetadata() });
        return;
      }
      const game = sessionService.createGame(auth.session.userId, gameType);
      res.status(201).json({
        scaffold: true,
        game,
        gameType: game.gameType,
        noWagerTrustLabel: "No-wager trusted demo scaffold",
      });
    });
  });

  app.post("/api/game/:gameId/join", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: `game:join:${req.params.gameId}`, principalKey: auth.session.userId }, () => {
      const joinResult = sessionService.joinGame(req.params.gameId, auth.session.userId);
      if (!joinResult.ok && joinResult.reason === "GAME_NOT_FOUND") {
        res.status(404).json({ error: "GAME_NOT_FOUND" });
        return;
      }
      if (!joinResult.ok && joinResult.reason === "GAME_FULL") {
        res.status(409).json({
          error: "GAME_FULL",
          note: "Game already has X and O players assigned.",
        });
        return;
      }

      const game = joinResult.game;
      const engine = getGameEngine(game.gameType);
      const status = engine ? engine.getStatus(game) : { kind: "open" as const };
      res.json({
        scaffold: true,
        game,
        gameType: game.gameType,
        playerSymbol: resolvePlayerSymbol(game, auth.session.userId),
        status,
      });
    });
  });

  app.get("/api/game/:gameId", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const game = store.getGame(req.params.gameId);
    if (!game) {
      res.status(404).json({ error: "GAME_NOT_FOUND" });
      return;
    }
    res.json({
      ...buildGamePayload(game, auth.session.userId),
      noWagerTrustLabel: "No-wager trusted demo scaffold",
    });
  });

  app.post("/api/game/:gameId/move", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: `game:move:${req.params.gameId}`, principalKey: auth.session.userId }, () => {
      const cell = Number(req.body?.cell);
      if (!Number.isInteger(cell)) {
        res.status(400).json({ error: "INVALID_CELL" });
        return;
      }
      const currentGame = sessionService.getGame(req.params.gameId);
      if (!currentGame) {
        res.status(404).json({ error: "GAME_NOT_FOUND" });
        return;
      }
      const engine = getGameEngine(currentGame.gameType);
      if (!engine) {
        res.status(400).json({ error: "GAME_TYPE_UNSUPPORTED", gameType: currentGame.gameType });
        return;
      }
      const result = engine.applyMove({
        sessionService,
        gameId: req.params.gameId,
        userId: auth.session.userId,
        cell,
      });
      if (!result) {
        res.status(404).json({ error: "GAME_NOT_FOUND" });
        return;
      }
      if (!result.ok) {
        res.status(400).json({
          scaffold: true,
          result,
          note: "Move rejected by deterministic EGI domain rule engine.",
        });
        return;
      }
      const game = store.getGame(req.params.gameId);
      if (!game) {
        res.status(404).json({ error: "GAME_NOT_FOUND" });
        return;
      }
      const status = engine.getStatus(game);
      rewardPolicy.onGameSettled({ game, status });
      res.json({
        ...buildGamePayload(game, auth.session.userId),
        result,
      });
    });
  });

  app.get("/api/rewards/get", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!requireCapabilityForWalletBoundAction(res, auth, "canReceiveRewards")) return;
    const rewardSnapshot = store.getRewards(auth.session.userId);
    if (!rewardSnapshot) {
      res.status(404).json({ error: "PROFILE_NOT_FOUND" });
      return;
    }
    res.json({ scaffold: true, rewardSnapshot });
  });

  app.post("/api/onchain/intent/create", (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    if (!requireCapabilityForWalletBoundAction(res, auth, "canWager")) return;
    withIdempotency(req, res, { scope: "onchain:intent:create", principalKey: auth.session.userId }, () => {
      const gameId = String(req.body?.gameId ?? "");
      const action = req.body?.action === "SYNC_RESULT" ? "SYNC_RESULT" : "SETTLE_GAME";
      const game = store.getGame(gameId);
      if (!game) {
        res.status(404).json({ error: "GAME_NOT_FOUND" });
        return;
      }
      const settlement = settlementPolicy.canCreateIntent({ game, action });
      if (!settlement.allowed) {
        res.status(400).json({ error: "SETTLEMENT_POLICY_BLOCKED", reason: settlement.reason });
        return;
      }
      const intent = store.createOnChainIntent(gameId, auth.session.userId, action);
      res.status(201).json({
        scaffold: true,
        intent,
        note: "On-chain intents are stubbed and deterministic for Day1 integration testing.",
      });
    });
  });

  app.get("/api/onchain/intent/:intentId/status", (req, res) => {
    const intent = store.getOnChainIntent(req.params.intentId);
    if (!intent) {
      res.status(404).json({ error: "INTENT_NOT_FOUND" });
      return;
    }
    res.json({
      scaffold: true,
      intent,
      note: "Status transitions are simulated and not blockchain-backed.",
    });
  });

  app.get("/api/server-wallet/status", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const walletStatus = walletManager.getStatus();
    res.json({
      scaffold: true,
      wallet: walletStatus,
      requestedBy: auth.session.userId,
      note: "Server wallet secret remains server-side and is never exposed to clients.",
    });
  });

  app.get("/api/ratification/schedule", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json({
      scaffold: true,
      schedule: ratificationService.getSchedule(),
      checkpoint: ratificationService.getCheckpoint(),
      adapter: ratificationService.getAdapterInfo(),
      requestedBy: auth.session.userId,
    });
  });

  app.post("/api/ratification/schedule", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: "ratification:schedule", principalKey: auth.session.userId }, () => {
      if (!ratificationService.canOverrideFromApi()) {
        res.status(403).json({
          error: "RATIFICATION_SCHEDULE_OVERRIDE_DISABLED",
          note: "Enable DAY1_RATIFY_ALLOW_API_OVERRIDE=true to allow API schedule changes.",
        });
        return;
      }
      const intervalMs = req.body?.intervalMs === undefined ? undefined : Number(req.body.intervalMs);
      const enabled = req.body?.enabled === undefined ? undefined : Boolean(req.body.enabled);
      if (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs <= 0)) {
        res.status(400).json({ error: "INVALID_INTERVAL_MS" });
        return;
      }
      const updated = ratificationService.updateSchedule({
        intervalMs: intervalMs === undefined ? undefined : Math.floor(intervalMs),
        enabled,
      });
      res.json({
        scaffold: true,
        schedule: updated,
        checkpoint: ratificationService.getCheckpoint(),
        adapter: ratificationService.getAdapterInfo(),
        requestedBy: auth.session.userId,
      });
    });
  });

  app.post("/api/ratification/run", async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    withIdempotency(req, res, { scope: "ratification:run", principalKey: auth.session.userId }, async () => {
      const adapter = ratificationService.getAdapterInfo();
      const wallet = walletManager.getStatus();
      const hasSubmitEndpoint = Boolean(process.env.DAY1_ERGO_NODE_URL);
      if (adapter.mode === "ergo" && (!wallet.ready || !hasSubmitEndpoint)) {
        res.status(503).json({
          error: "ERGO_MODE_CONFIGURATION_INCOMPLETE",
          reason: "Real chain mode requires server wallet readiness and DAY1_ERGO_NODE_URL.",
          adapter,
          wallet,
        });
        return;
      }
      const result = await ratificationService.runNow();
      res.status(result.outcome === "error" ? 500 : 200).json({
        scaffold: true,
        run: {
          ...result,
          skipReason:
            result.outcome === "skipped" || result.outcome === "noop"
              ? result.reason
              : undefined,
          reasonMessage: describeRatificationReason(result.reason),
        },
        checkpoint: ratificationService.getCheckpoint(),
        adapter,
        requestedBy: auth.session.userId,
      });
    });
  });

  app.post("/api/ratification/batches/:batchId/submit-signed", async (req, res) => {
    const auth = requireAuthForMutation(req, res);
    if (!auth) return;
    withIdempotency(
      req,
      res,
      { scope: `ratification:submit-signed:${req.params.batchId}`, principalKey: auth.session.userId },
      async () => {
        const signedTxHex = String(req.body?.signedTxHex ?? "").trim();
        if (!signedTxHex) {
          res.status(400).json({ error: "SIGNED_TX_REQUIRED" });
          return;
        }
        const submitResult = await ratificationService.submitSignedBatch(req.params.batchId, signedTxHex);
        res.status(submitResult.outcome === "error" ? 500 : 200).json({
          scaffold: true,
          run: submitResult,
          checkpoint: ratificationService.getCheckpoint(),
          adapter: ratificationService.getAdapterInfo(),
          requestedBy: auth.session.userId,
        });
      }
    );
  });

  app.get("/api/ratification/batches", async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await ratificationService.processPendingConfirmations();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25) || 25));
    res.json({
      scaffold: true,
      batches: ratificationService.listBatches(limit),
      checkpoint: ratificationService.getCheckpoint(),
      adapter: ratificationService.getAdapterInfo(),
      requestedBy: auth.session.userId,
    });
  });

  app.get("/api/truth-stack", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 60) || 60));
    const recent = Math.max(1, Math.min(25, Number(req.query.recent ?? 8) || 8));
    const checkpoint = store.getRatificationCheckpoint();
    const events = store.listRatifiableEventsSince(0, limit);
    const batches = store.listRatificationBatches(limit);
    const onChainIntents = store.listOnChainIntents(limit);
    const games = store.listGames();
    const gameTypeById = new Map(games.map((game) => [game.gameId, game.gameType]));
    const truth = buildTruthLedgerView(
      {
        events,
        checkpoint,
        batches,
        onChainIntents,
        gameTypeById,
      },
      recent
    );
    res.json({
      scaffold: true,
      truth,
      requestedBy: auth.session.userId,
      generatedAt: new Date().toISOString(),
      note: "No-wager truth stack showing pending, ratified, and on-chain gate source records.",
    });
  });

  return app;
};
