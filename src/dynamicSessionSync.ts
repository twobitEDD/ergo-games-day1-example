export interface WaitForAuthTokenOptions {
  maxRetries: number;
  retryDelayMs: number;
  getToken: () => string | null | undefined;
  sleep: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, maxRetries: number) => void;
}

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
