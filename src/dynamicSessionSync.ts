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

export const isDynamicConfigurationError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("DYNAMIC_AUTH_NOT_CONFIGURED") || message.includes("DYNAMIC_AUTH_UNAVAILABLE");
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
