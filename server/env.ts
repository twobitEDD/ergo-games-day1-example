import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

const DEFAULT_ENV_FILES = [".env.local", ".env"] as const;
const RATIFICATION_ENV_KEYS = [
  "DAY1_CHAIN_MODE",
  "DAY1_CHAIN_NETWORK",
  "DAY1_SERVER_WALLET_ADDRESS",
  "DAY1_SERVER_WALLET_SECRET",
  "DAY1_ERGO_NODE_URL",
  "DAY1_ERGO_EXPLORER_URL",
  "DAY1_ERGO_SIGNING_MODE",
  "DAY1_RATIFY_INTERVAL_MS",
  "DAY1_RATIFY_BATCH_MAX_RECORDS",
  "DAY1_RATIFY_MIN_INTERVAL_MS",
  "DAY1_RATIFY_MAX_INTERVAL_MS",
  "DAY1_RATIFY_FINALITY_DEPTH",
  "DAY1_RATIFY_ALLOW_API_OVERRIDE",
  "DAY1_DYNAMIC_AUTH_ENABLED",
  "DAY1_DYNAMIC_JWT_ISSUER",
  "DAY1_DYNAMIC_JWT_AUDIENCE",
  "DAY1_DYNAMIC_JWKS_URL",
] as const;

const SENSITIVE_ENV_KEYS = new Set<string>(["DAY1_SERVER_WALLET_SECRET"]);
const MASKED_ENV_KEYS = new Set<string>(["DAY1_SERVER_WALLET_ADDRESS"]);
const LOAD_REPORT_UNINITIALIZED_NOTE =
  "Env bootstrap has not run in this process. Start server via npm run dev:server or npm run dev.";

export interface Day1EnvLoadReport {
  cwd: string;
  attemptedFiles: string[];
  loadedFiles: string[];
  loadErrors: Array<{ file: string; message: string }>;
}

interface LoadDay1EnvOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  files?: readonly string[];
}

interface RatificationEnvKeySnapshot {
  configured: boolean;
  redaction: "none" | "masked" | "secret";
  valuePreview?: string;
}

let cachedProcessLoadReport: Day1EnvLoadReport | null = null;

const maskValue = (value: string) => {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const toKeySnapshot = (key: string, env: NodeJS.ProcessEnv): RatificationEnvKeySnapshot => {
  const raw = env[key]?.trim();
  const configured = Boolean(raw);
  if (!configured || !raw) {
    return {
      configured: false,
      redaction: SENSITIVE_ENV_KEYS.has(key) ? "secret" : MASKED_ENV_KEYS.has(key) ? "masked" : "none",
    };
  }
  if (SENSITIVE_ENV_KEYS.has(key)) {
    return {
      configured: true,
      redaction: "secret",
      valuePreview: `[redacted:${raw.length} chars]`,
    };
  }
  if (MASKED_ENV_KEYS.has(key)) {
    return {
      configured: true,
      redaction: "masked",
      valuePreview: maskValue(raw),
    };
  }
  return { configured: true, redaction: "none", valuePreview: raw };
};

export const loadDay1Env = (options: LoadDay1EnvOptions = {}): Day1EnvLoadReport => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envFiles = options.files ?? DEFAULT_ENV_FILES;
  const canUseCache =
    env === process.env &&
    !options.cwd &&
    !options.files &&
    cachedProcessLoadReport !== null;
  if (canUseCache && cachedProcessLoadReport) return cachedProcessLoadReport;

  const attemptedFiles: string[] = [];
  const loadedFiles: string[] = [];
  const loadErrors: Array<{ file: string; message: string }> = [];
  for (const file of envFiles) {
    const absolutePath = resolve(cwd, file);
    attemptedFiles.push(file);
    if (!existsSync(absolutePath)) continue;
    const result = dotenvConfig({
      path: absolutePath,
      override: false,
      processEnv: env,
      quiet: true,
    });
    if (result.error) {
      loadErrors.push({ file, message: result.error.message });
      continue;
    }
    loadedFiles.push(file);
  }

  const report: Day1EnvLoadReport = { cwd, attemptedFiles, loadedFiles, loadErrors };
  if (env === process.env && !options.cwd && !options.files) {
    cachedProcessLoadReport = report;
  }
  return report;
};

export const getDay1EnvLoadReport = () => cachedProcessLoadReport;

export const getRatificationEnvDebugSnapshot = (env: NodeJS.ProcessEnv = process.env) => {
  const envLoad = getDay1EnvLoadReport();
  const byKey = Object.fromEntries(
    RATIFICATION_ENV_KEYS.map((key) => [key, toKeySnapshot(key, env)])
  ) as Record<(typeof RATIFICATION_ENV_KEYS)[number], RatificationEnvKeySnapshot>;
  const walletReady = byKey.DAY1_SERVER_WALLET_ADDRESS.configured && byKey.DAY1_SERVER_WALLET_SECRET.configured;
  const hasSubmitEndpoint = byKey.DAY1_ERGO_NODE_URL.configured;
  const hasStatusEndpoint = byKey.DAY1_ERGO_EXPLORER_URL.configured || byKey.DAY1_ERGO_NODE_URL.configured;
  const inferredErgoConfigReady = walletReady && hasSubmitEndpoint;
  return {
    envBootstrap: envLoad ?? {
      cwd: process.cwd(),
      attemptedFiles: [],
      loadedFiles: [],
      loadErrors: [],
      note: LOAD_REPORT_UNINITIALIZED_NOTE,
    },
    ratificationEnv: byKey,
    inferred: {
      walletReady,
      hasSubmitEndpoint,
      hasStatusEndpoint,
      ergoConfigReady: inferredErgoConfigReady,
    },
  };
};
