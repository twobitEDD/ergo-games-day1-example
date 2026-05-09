import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import request from "supertest";
import { createDay1App } from "./app";
import { buildDeterministicArtifact } from "./ratification";
import { Day1Store } from "./store";

const withEnv = <T>(entries: Record<string, string | undefined>, run: () => Promise<T> | T) => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const finalize = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const output = run();
    if (output && typeof (output as Promise<T>).then === "function") {
      return (output as Promise<T>).finally(finalize);
    }
    finalize();
    return output;
  } catch (error) {
    finalize();
    throw error;
  }
};

const createTestContext = () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-ratification-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, { enableRatificationScheduler: false });
  const client = request.agent(app);
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, client, cleanup };
};

const withCsrf = (client: request.SuperAgentTest, csrfToken: string) => (path: string) =>
  client.post(path).set("x-day1-csrf-token", csrfToken);

const register = async (
  client: request.SuperAgentTest,
  payload: { displayName: string; email: string; password: string }
) => {
  const response = await client.post("/api/auth/register").send(payload).expect(201);
  return {
    userId: response.body.session.userId as string,
    csrfToken: response.body.csrfToken as string,
  };
};

const createCompletedGameEvents = async (
  hostClient: request.SuperAgentTest,
  hostCsrfToken: string,
  guestClient: request.SuperAgentTest,
  guestCsrfToken: string
) => {
  const hostPost = withCsrf(hostClient, hostCsrfToken);
  const guestPost = withCsrf(guestClient, guestCsrfToken);
  const gameCreated = await hostPost("/api/game/create").send({}).expect(201);
  const gameId = gameCreated.body.game.gameId as string;
  await guestPost(`/api/game/${gameId}/join`).send({}).expect(200);
  await hostPost(`/api/game/${gameId}/move`).send({ cell: 0 }).expect(200);
  await guestPost(`/api/game/${gameId}/move`).send({ cell: 3 }).expect(200);
  await hostPost(`/api/game/${gameId}/move`).send({ cell: 1 }).expect(200);
  return gameId;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("buildDeterministicArtifact keeps stable ordering and hashes", () => {
  const unordered = [
    {
      eventId: 9,
      createdAt: "2026-01-01T00:00:00.000Z",
      gameId: "game_a",
      type: "MOVE_APPLIED",
      actorUserId: "user_x",
      cell: 2,
      nextTurn: "O" as const,
      winner: undefined,
      drawn: false,
    },
    {
      eventId: 7,
      createdAt: "2026-01-01T00:00:01.000Z",
      gameId: "game_a",
      type: "MOVE_APPLIED",
      actorUserId: "user_o",
      cell: 4,
      nextTurn: "X" as const,
      winner: undefined,
      drawn: false,
    },
  ];
  const artifactA = buildDeterministicArtifact(unordered);
  const artifactB = buildDeterministicArtifact([...unordered].reverse());
  assert.deepEqual(artifactA.records.map((entry) => entry.eventId), [7, 9]);
  assert.equal(artifactA.recordHash, artifactB.recordHash);
  assert.equal(artifactA.merkleRoot, artifactB.merkleRoot);
});

test("ratification run is gated when server wallet is not ready", async () =>
  withEnv(
    {
      DAY1_SERVER_WALLET_ADDRESS: undefined,
      DAY1_SERVER_WALLET_SECRET: undefined,
      DAY1_RATIFY_ALLOW_API_OVERRIDE: "false",
    },
    async () => {
      const { client, cleanup } = createTestContext();
      try {
        const registration = await register(client, {
          displayName: "Wallet Gate",
          email: "wallet-gate@example.local",
          password: "wallet-gate-123",
        });
        const runResponse = await withCsrf(client, registration.csrfToken)("/api/ratification/run").send({}).expect(200);
        assert.equal(runResponse.body.run.outcome, "skipped");
        assert.equal(runResponse.body.run.reason, "SERVER_WALLET_NOT_READY");
      } finally {
        cleanup();
      }
    }
  ));

test("ratification adapter mode follows chain mode env", async () =>
  withEnv(
    {
      DAY1_CHAIN_MODE: "ergo",
      DAY1_CHAIN_NETWORK: "testnet",
      DAY1_SERVER_WALLET_ADDRESS: "9adapter_mode_wallet",
      DAY1_SERVER_WALLET_SECRET: "adapter-mode-secret",
      DAY1_ERGO_NODE_URL: "http://localhost:9053",
    },
    async () => {
      const { client, cleanup } = createTestContext();
      try {
        const registration = await register(client, {
          displayName: "Mode Probe",
          email: "mode-probe@example.local",
          password: "mode-probe-123",
        });
        const scheduleResponse = await client.get("/api/ratification/schedule").expect(200);
        assert.equal(scheduleResponse.body.adapter.mode, "ergo");
        assert.equal(scheduleResponse.body.adapter.network, "testnet");
        assert.equal(scheduleResponse.body.adapter.signerMode, "external");
        assert.equal(typeof registration.csrfToken, "string");
      } finally {
        cleanup();
      }
    }
  ));

test("ratification adapter exposes public-sponsor signer mode", async () =>
  withEnv(
    {
      DAY1_CHAIN_MODE: "ergo",
      DAY1_CHAIN_NETWORK: "mainnet",
      DAY1_SERVER_WALLET_ADDRESS: "9sponsor_wallet",
      DAY1_SERVER_WALLET_SECRET: "sponsor-secret",
      DAY1_ERGO_SIGNING_MODE: "public-sponsor",
      DAY1_ERGO_NODE_URL: "http://localhost:9053",
    },
    async () => {
      const { client, cleanup } = createTestContext();
      try {
        await register(client, {
          displayName: "Sponsor Probe",
          email: "sponsor-probe@example.local",
          password: "sponsor-probe-123",
        });
        const scheduleResponse = await client.get("/api/ratification/schedule").expect(200);
        assert.equal(scheduleResponse.body.adapter.mode, "ergo");
        assert.equal(scheduleResponse.body.adapter.signerMode, "public-sponsor");
        assert.equal(scheduleResponse.body.adapter.externalSigner, true);
      } finally {
        cleanup();
      }
    }
  ));

test("ergo mode refuses run when wallet or endpoints are incomplete", async () =>
  withEnv(
    {
      DAY1_CHAIN_MODE: "ergo",
      DAY1_CHAIN_NETWORK: "testnet",
      DAY1_SERVER_WALLET_ADDRESS: undefined,
      DAY1_SERVER_WALLET_SECRET: undefined,
      DAY1_ERGO_NODE_URL: undefined,
      DAY1_ERGO_EXPLORER_URL: undefined,
    },
    async () => {
      const { client, cleanup } = createTestContext();
      try {
        const registration = await register(client, {
          displayName: "Real Refusal",
          email: "real-refusal@example.local",
          password: "real-refusal-123",
        });
        const response = await withCsrf(client, registration.csrfToken)("/api/ratification/run").send({}).expect(503);
        assert.equal(response.body.error, "ERGO_MODE_CONFIGURATION_INCOMPLETE");
      } finally {
        cleanup();
      }
    }
  ));

test("ratification submission and confirmation update checkpoint lifecycle", async () =>
  withEnv(
    {
      DAY1_SERVER_WALLET_ADDRESS: "9fake_wallet_address",
      DAY1_SERVER_WALLET_SECRET: "server-secret-for-tests",
      DAY1_RATIFY_BATCH_MAX_RECORDS: "20",
      DAY1_RATIFY_INTERVAL_MS: "20000",
      DAY1_RATIFY_ALLOW_API_OVERRIDE: "true",
    },
    async () => {
      const { app, client: hostClient, cleanup } = createTestContext();
      try {
        const host = await register(hostClient, {
          displayName: "Host",
          email: "ratif-host@example.local",
          password: "host-pass-123",
        });
        const guestClient = request.agent(app);
        const guest = await register(guestClient, {
          displayName: "Guest",
          email: "ratif-guest@example.local",
          password: "guest-pass-123",
        });
        await createCompletedGameEvents(hostClient, host.csrfToken, guestClient, guest.csrfToken);

        const hostPost = withCsrf(hostClient, host.csrfToken);
        const firstRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(firstRun.body.run.outcome, "submitted");
        const batchId = firstRun.body.run.batchId as string;
        assert.ok(batchId);

        const secondRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.ok(["confirmed", "noop", "submitted", "skipped"].includes(secondRun.body.run.outcome));
        if (secondRun.body.run.outcome === "skipped") {
          assert.ok(
            ["COOLDOWN_NOT_REACHED", "ALREADY_RATIFIED_THIS_BLOCK"].includes(secondRun.body.run.skipReason ?? "")
          );
        }

        const batchesResponse = await hostClient.get("/api/ratification/batches?limit=10").expect(200);
        const createdBatch = batchesResponse.body.batches.find((entry: { batchId: string }) => entry.batchId === batchId);
        assert.ok(createdBatch);
        assert.equal(createdBatch.status, "confirmed");
        assert.ok(createdBatch.txId);
        assert.ok(createdBatch.recordCount >= 1);
        assert.ok(Number(createdBatch.toEventId) >= Number(createdBatch.fromEventId));

        const scheduleResponse = await hostClient.get("/api/ratification/schedule").expect(200);
        assert.equal(scheduleResponse.body.checkpoint.lastBatchId, batchId);
        assert.ok(scheduleResponse.body.checkpoint.lastAnchoredEventId >= 1);
      } finally {
        cleanup();
      }
    }
  ));

test("ergo external signer flow persists awaiting signature then submits signed tx", async () =>
  withEnv(
    {
      DAY1_CHAIN_MODE: "ergo",
      DAY1_CHAIN_NETWORK: "testnet",
      DAY1_SERVER_WALLET_ADDRESS: "9real_wallet",
      DAY1_SERVER_WALLET_SECRET: "real-wallet-secret",
      DAY1_ERGO_NODE_URL: "http://ergo-node.local",
      DAY1_ERGO_EXPLORER_URL: "http://ergo-explorer.local",
      DAY1_RATIFY_BATCH_MAX_RECORDS: "20",
    },
    async () => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/transactions")) {
          return new Response(JSON.stringify({ id: "ergo_tx_mock_001" }), { status: 200 });
        }
        if (url.includes("/api/v1/transactions/")) {
          return new Response(JSON.stringify({ confirmations: 8 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const { app, client: hostClient, cleanup } = createTestContext();
      try {
        const host = await register(hostClient, {
          displayName: "Real Host",
          email: "real-host@example.local",
          password: "real-host-123",
        });
        const guestClient = request.agent(app);
        const guest = await register(guestClient, {
          displayName: "Real Guest",
          email: "real-guest@example.local",
          password: "real-guest-123",
        });
        await createCompletedGameEvents(hostClient, host.csrfToken, guestClient, guest.csrfToken);
        const hostPost = withCsrf(hostClient, host.csrfToken);

        const firstRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(firstRun.body.run.outcome, "awaiting_signature");
        const batchId = firstRun.body.run.batchId as string;
        assert.ok(batchId);

        const batchesBeforeSigned = await hostClient.get("/api/ratification/batches?limit=10").expect(200);
        const awaitingBatch = batchesBeforeSigned.body.batches.find((entry: { batchId: string }) => entry.batchId === batchId);
        assert.equal(awaitingBatch.status, "awaiting_signature");
        assert.equal(awaitingBatch.confirmationStatus, "pending");
        assert.ok(awaitingBatch.signerPayloadJson);

        const submitSigned = await hostPost(`/api/ratification/batches/${batchId}/submit-signed`)
          .send({ signedTxHex: "deadbeef" })
          .expect(200);
        assert.equal(submitSigned.body.run.outcome, "submitted");
        assert.equal(submitSigned.body.run.txId, "ergo_tx_mock_001");

        const batchesAfterSigned = await hostClient.get("/api/ratification/batches?limit=10").expect(200);
        const finalizedBatch = batchesAfterSigned.body.batches.find((entry: { batchId: string }) => entry.batchId === batchId);
        assert.equal(finalizedBatch.status, "confirmed");
        assert.equal(finalizedBatch.confirmationStatus, "finalized");
        assert.ok(finalizedBatch.confirmationDepth >= 6);
      } finally {
        globalThis.fetch = previousFetch;
        cleanup();
      }
    }
  ));

test("ratification schedule override honors guard", async () =>
  withEnv(
    {
      DAY1_SERVER_WALLET_ADDRESS: "9schedule_wallet",
      DAY1_SERVER_WALLET_SECRET: "schedule-secret",
      DAY1_RATIFY_ALLOW_API_OVERRIDE: "false",
    },
    async () => {
      const { client, cleanup } = createTestContext();
      try {
        const registration = await register(client, {
          displayName: "Schedule Tester",
          email: "schedule@example.local",
          password: "schedule-pass-123",
        });
        await withCsrf(client, registration.csrfToken)("/api/ratification/schedule").send({ intervalMs: 15000 }).expect(403);
      } finally {
        cleanup();
      }
    }
  ));

test("ratification cooldown gates runs based on last successful ratification", async () =>
  withEnv(
    {
      DAY1_SERVER_WALLET_ADDRESS: "9cooldown_wallet",
      DAY1_SERVER_WALLET_SECRET: "cooldown-secret",
      DAY1_RATIFY_INTERVAL_MS: "60000",
      DAY1_SIMULATED_BLOCK_INTERVAL_MS: "60000",
    },
    async () => {
      const { app, client: hostClient, cleanup } = createTestContext();
      try {
        const host = await register(hostClient, {
          displayName: "Cooldown Host",
          email: "cooldown-host@example.local",
          password: "cooldown-host-123",
        });
        const guestClient = request.agent(app);
        const guest = await register(guestClient, {
          displayName: "Cooldown Guest",
          email: "cooldown-guest@example.local",
          password: "cooldown-guest-123",
        });
        const hostPost = withCsrf(hostClient, host.csrfToken);
        const guestPost = withCsrf(guestClient, guest.csrfToken);
        const gameId = await createCompletedGameEvents(hostClient, host.csrfToken, guestClient, guest.csrfToken);

        const firstRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(firstRun.body.run.outcome, "submitted");

        await guestPost(`/api/game/${gameId}/move`).send({ cell: 4 }).expect(200);
        const secondRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(secondRun.body.run.outcome, "skipped");
        assert.equal(secondRun.body.run.skipReason, "COOLDOWN_NOT_REACHED");
        assert.equal(secondRun.body.run.reason, "COOLDOWN_NOT_REACHED");
        assert.ok(secondRun.body.checkpoint.lastSuccessfulRatificationAt);
      } finally {
        cleanup();
      }
    }
  ));

test("ratification prevents duplicate success in same block", async () =>
  withEnv(
    {
      DAY1_SERVER_WALLET_ADDRESS: "9same_block_wallet",
      DAY1_SERVER_WALLET_SECRET: "same-block-secret",
      DAY1_RATIFY_INTERVAL_MS: "1",
      DAY1_SIMULATED_BLOCK_INTERVAL_MS: "60000",
    },
    async () => {
      const { app, client: hostClient, cleanup } = createTestContext();
      try {
        const host = await register(hostClient, {
          displayName: "Same Block Host",
          email: "same-block-host@example.local",
          password: "same-block-host-123",
        });
        const guestClient = request.agent(app);
        const guest = await register(guestClient, {
          displayName: "Same Block Guest",
          email: "same-block-guest@example.local",
          password: "same-block-guest-123",
        });
        const hostPost = withCsrf(hostClient, host.csrfToken);
        const guestPost = withCsrf(guestClient, guest.csrfToken);
        const gameId = await createCompletedGameEvents(hostClient, host.csrfToken, guestClient, guest.csrfToken);

        const firstRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(firstRun.body.run.outcome, "submitted");
        await guestPost(`/api/game/${gameId}/move`).send({ cell: 4 }).expect(200);
        await sleep(5);
        const secondRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(secondRun.body.run.outcome, "skipped");
        assert.equal(secondRun.body.run.skipReason, "ALREADY_RATIFIED_THIS_BLOCK");
        assert.equal(secondRun.body.run.reason, "ALREADY_RATIFIED_THIS_BLOCK");
      } finally {
        cleanup();
      }
    }
  ));

test("ratification can run again on next simulated block with eligible events", async () =>
  withEnv(
    {
      DAY1_SERVER_WALLET_ADDRESS: "9next_block_wallet",
      DAY1_SERVER_WALLET_SECRET: "next-block-secret",
      DAY1_RATIFY_INTERVAL_MS: "1",
      DAY1_SIMULATED_BLOCK_INTERVAL_MS: "15",
    },
    async () => {
      const { app, client: hostClient, cleanup } = createTestContext();
      try {
        const host = await register(hostClient, {
          displayName: "Next Block Host",
          email: "next-block-host@example.local",
          password: "next-block-host-123",
        });
        const guestClient = request.agent(app);
        const guest = await register(guestClient, {
          displayName: "Next Block Guest",
          email: "next-block-guest@example.local",
          password: "next-block-guest-123",
        });
        const hostPost = withCsrf(hostClient, host.csrfToken);
        const guestPost = withCsrf(guestClient, guest.csrfToken);
        const gameId = await createCompletedGameEvents(hostClient, host.csrfToken, guestClient, guest.csrfToken);

        const firstRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(firstRun.body.run.outcome, "submitted");
        await guestPost(`/api/game/${gameId}/move`).send({ cell: 4 }).expect(200);
        await sleep(30);
        const secondRun = await hostPost("/api/ratification/run").send({}).expect(200);
        assert.equal(secondRun.body.run.outcome, "submitted");
        assert.notEqual(secondRun.body.run.batchId, firstRun.body.run.batchId);
        assert.ok(
          typeof secondRun.body.checkpoint.lastRatifiedBlockHeight === "number" &&
            secondRun.body.checkpoint.lastRatifiedBlockHeight >= 0
        );
      } finally {
        cleanup();
      }
    }
  ));
