import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { getRatificationEnvDebugSnapshot, loadDay1Env } from "./env";

test("loadDay1Env applies shell > .env.local > .env precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-env-load-"));
  try {
    writeFileSync(
      join(dir, ".env"),
      [
        "DAY1_CHAIN_MODE=simulated",
        "DAY1_CHAIN_NETWORK=mainnet",
        "DAY1_SERVER_WALLET_ADDRESS=9from_env_file",
        "DAY1_ERGO_NODE_URL=http://env-node.local",
      ].join("\n")
    );
    writeFileSync(
      join(dir, ".env.local"),
      [
        "DAY1_CHAIN_MODE=ergo",
        "DAY1_SERVER_WALLET_ADDRESS=9from_env_local",
        "DAY1_ERGO_EXPLORER_URL=http://env-local-explorer.local",
      ].join("\n")
    );

    const env: NodeJS.ProcessEnv = {
      DAY1_CHAIN_NETWORK: "testnet",
      DAY1_SERVER_WALLET_SECRET: "shell-secret-value",
    };
    const report = loadDay1Env({ cwd: dir, env });
    assert.deepEqual(report.loadedFiles, [".env.local", ".env"]);
    assert.equal(env.DAY1_CHAIN_MODE, "ergo");
    assert.equal(env.DAY1_CHAIN_NETWORK, "testnet");
    assert.equal(env.DAY1_SERVER_WALLET_ADDRESS, "9from_env_local");
    assert.equal(env.DAY1_ERGO_NODE_URL, "http://env-node.local");
    assert.equal(env.DAY1_ERGO_EXPLORER_URL, "http://env-local-explorer.local");
    assert.equal(env.DAY1_SERVER_WALLET_SECRET, "shell-secret-value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratification env debug snapshot redacts secrets safely", () => {
  const env: NodeJS.ProcessEnv = {
    DAY1_SERVER_WALLET_ADDRESS: "9abcd1234secretaddress",
    DAY1_SERVER_WALLET_SECRET: "super-secret-value",
    DAY1_ERGO_NODE_URL: "http://localhost:9053",
  };
  const snapshot = getRatificationEnvDebugSnapshot(env);
  assert.equal(snapshot.ratificationEnv.DAY1_SERVER_WALLET_ADDRESS.configured, true);
  assert.equal(snapshot.ratificationEnv.DAY1_SERVER_WALLET_ADDRESS.redaction, "masked");
  assert.match(snapshot.ratificationEnv.DAY1_SERVER_WALLET_ADDRESS.valuePreview ?? "", /^9abc\.\.\..+/);
  assert.equal(snapshot.ratificationEnv.DAY1_SERVER_WALLET_SECRET.redaction, "secret");
  assert.match(snapshot.ratificationEnv.DAY1_SERVER_WALLET_SECRET.valuePreview ?? "", /\[redacted:/);
  assert.equal(snapshot.ratificationEnv.DAY1_ERGO_NODE_URL.valuePreview, "http://localhost:9053");
  assert.equal(snapshot.inferred.walletReady, true);
  assert.equal(snapshot.inferred.hasSubmitEndpoint, true);
  assert.equal(snapshot.inferred.hasStatusEndpoint, true);
  assert.equal(snapshot.inferred.ergoConfigReady, true);
});
