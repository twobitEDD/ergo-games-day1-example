export interface WaitForAuthTokenOptions {
  maxRetries: number;
  retryDelayMs: number;
  getToken: () => string | null | undefined;
  sleep: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, maxRetries: number) => void;
}

export interface RetryWithBackoffOptions<T> {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  run: (attempt: number) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown, attempt: number, maxAttempts: number) => boolean;
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: unknown) => void;
}

export interface AutoBridgeAttemptPolicyInput {
  dynamicReady: boolean;
  identityKey: string | null;
  identityChanged: boolean;
  becameReady: boolean;
  hasBackendSession: boolean;
  hasAuthBlockingReason: boolean;
  authMode: "jwt_verified" | null;
  syncInFlight: boolean;
  syncInProgress: boolean;
  nowMs: number;
  cooldownUntilMs: number;
  attemptsForIdentity: number;
  maxAttemptsPerIdentity: number;
  lastAttemptAtMs: number;
  minAttemptGapMs: number;
  hardBlockedIdentityKey: string | null;
}

/**
 * Dynamic -> Day1 bridge policy:
 * - Retry only for clearly transient/network/session-readiness failures.
 * - Never auto-retry hard failures (invalid token, identity conflict, bad request).
 * - Auto-bridge attempts are debounced and capped per identity.
 */
const HARD_DYNAMIC_BRIDGE_ERROR_MARKERS = [
  "DYNAMIC_AUTH_NOT_CONFIGURED",
  "DYNAMIC_TOKEN_INVALID",
  "DYNAMIC_IDENTITY_CONFLICT",
  "DYNAMIC_AUTH_TOKEN_REQUIRED",
  "400",
  "401",
  "403",
  "404",
] as const;

const TRANSIENT_DYNAMIC_BRIDGE_ERROR_MARKERS = [
  "DYNAMIC_AUTH_UNAVAILABLE",
  "SESSION_NOT_FOUND",
  "MISSING_SESSION",
  "408",
  "409",
  "425",
  "429",
  "500",
  "502",
  "503",
  "504",
] as const;

const TRANSIENT_DYNAMIC_BRIDGE_ERROR_PATTERNS = [
  /failed to fetch/i,
  /network ?error/i,
  /fetch failed/i,
  /load failed/i,
  /timeout/i,
] as const;

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "");

export const isDynamicConfigurationError = (error: unknown) => {
  const message = toErrorMessage(error);
  return message.includes("DYNAMIC_AUTH_NOT_CONFIGURED") || message.includes("DYNAMIC_AUTH_UNAVAILABLE");
};

export const isHardDynamicBridgeError = (error: unknown) => {
  const message = toErrorMessage(error);
  return HARD_DYNAMIC_BRIDGE_ERROR_MARKERS.some((marker) => message.includes(marker));
};

export const isTransientDynamicBridgeError = (error: unknown) => {
  const message = toErrorMessage(error);
  if (isDynamicConfigurationError(error)) return false;
  if (isHardDynamicBridgeError(error)) return false;
  if (TRANSIENT_DYNAMIC_BRIDGE_ERROR_MARKERS.some((marker) => message.includes(marker))) return true;
  return TRANSIENT_DYNAMIC_BRIDGE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};

export const shouldRetryDynamicBridgeError = (error: unknown) => isTransientDynamicBridgeError(error);

export const shouldStartAutoBridgeAttempt = (input: AutoBridgeAttemptPolicyInput) => {
  if (!input.dynamicReady || !input.identityKey) return false;
  if (input.syncInFlight || input.syncInProgress) return false;
  if (input.hardBlockedIdentityKey && input.hardBlockedIdentityKey === input.identityKey) return false;
  const shouldAttemptForState =
    input.becameReady ||
    input.identityChanged ||
    !input.hasBackendSession ||
    input.hasAuthBlockingReason ||
    input.authMode !== "jwt_verified";
  if (!shouldAttemptForState) return false;
  if (input.nowMs < input.cooldownUntilMs) return false;
  if (input.attemptsForIdentity >= input.maxAttemptsPerIdentity) return false;
  if (input.lastAttemptAtMs > 0 && input.nowMs - input.lastAttemptAtMs < input.minAttemptGapMs) return false;
  return true;
};

export const waitForAuthTokenWithRetry = async ({
  maxRetries,
  retryDelayMs,
  getToken,
  sleep,
  onRetry,
}: WaitForAuthTokenOptions): Promise<string> => {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const token = getToken()?.trim();
    if (token) return token;
    onRetry?.(attempt + 1, maxRetries);
    if (attempt < maxRetries - 1) {
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw new Error("Dynamic auth token was unavailable. Re-open Dynamic auth and try again.");
};

export const retryWithBoundedBackoff = async <T>({
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
  run,
  sleep,
  shouldRetry,
  onRetry,
}: RetryWithBackoffOptions<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < maxAttempts && (typeof shouldRetry === "function" ? shouldRetry(error, attempt, maxAttempts) : true);
      if (!canRetry) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      onRetry?.(attempt, maxAttempts, delayMs, error);
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("Retry attempts exhausted.");
};
