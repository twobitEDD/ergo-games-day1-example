import type { Day1Store, RateLimitPolicy } from "./store";

export interface RateLimitStatus {
  blocked: boolean;
  attempts: number;
  retryAfterMs: number;
}

export interface RateLimitReadiness {
  adapter: "sqlite" | "redis-scaffold";
  ready: boolean;
  detail: string;
}

export interface RateLimiterAdapter {
  getStatus(key: string, policy: RateLimitPolicy): RateLimitStatus;
  registerFailure(key: string, policy: RateLimitPolicy): void;
  clear(key: string): void;
  readiness(): RateLimitReadiness;
}

class SqliteRateLimiterAdapter implements RateLimiterAdapter {
  constructor(private readonly store: Day1Store) {}

  getStatus(key: string, policy: RateLimitPolicy) {
    return this.store.getRateLimitStatus(key, policy);
  }

  registerFailure(key: string, policy: RateLimitPolicy) {
    this.store.registerRateLimitFailure(key, policy);
  }

  clear(key: string) {
    this.store.clearRateLimit(key);
  }

  readiness() {
    return { adapter: "sqlite" as const, ready: true, detail: "sqlite-auth_rate_limits" };
  }
}

class RedisRateLimiterScaffoldAdapter implements RateLimiterAdapter {
  constructor(private readonly fallback: SqliteRateLimiterAdapter, private readonly redisUrl?: string) {}

  getStatus(key: string, policy: RateLimitPolicy) {
    return this.fallback.getStatus(key, policy);
  }

  registerFailure(key: string, policy: RateLimitPolicy) {
    this.fallback.registerFailure(key, policy);
  }

  clear(key: string) {
    this.fallback.clear(key);
  }

  readiness() {
    return {
      adapter: "redis-scaffold" as const,
      ready: Boolean(this.redisUrl),
      detail: this.redisUrl
        ? "redis-scaffold-configured-fallback-active"
        : "redis-scaffold-missing-url-fallback-active",
    };
  }
}

export const createRateLimiterAdapter = (store: Day1Store, env: NodeJS.ProcessEnv = process.env): RateLimiterAdapter => {
  const sqlite = new SqliteRateLimiterAdapter(store);
  if (String(env.DAY1_RATE_LIMIT_ADAPTER ?? "sqlite").toLowerCase() !== "redis") return sqlite;
  return new RedisRateLimiterScaffoldAdapter(sqlite, env.DAY1_REDIS_URL?.trim() || undefined);
};
