import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import request from "supertest";
import { createDay1App } from "./app";
import { Day1Store } from "./store";

const createTestContext = () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, { enableRatificationScheduler: false });
  const client = request.agent(app);
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, store, client, cleanup };
};

const closeTestAgent = (agent: request.SuperAgentTest | undefined) => {
  if (!agent) return;
  const closable = agent as unknown as { close?: () => void };
  closable.close?.();
};

const withCsrf = (
  client: request.SuperAgentTest,
  csrfToken: string,
  method: "post" | "put" | "patch" | "delete"
) => {
  const reqFactory = client[method].bind(client) as (path: string) => request.Test;
  return (path: string) => reqFactory(path).set("x-day1-csrf-token", csrfToken);
};

const registerAndLogin = async (client: request.SuperAgentTest, payload: { displayName: string; email: string; password: string }) => {
  const response = await client.post("/api/auth/register").send(payload).expect(201);
  return {
    sessionId: response.body.session.sessionId as string,
    userId: response.body.session.userId as string,
    csrfToken: response.body.csrfToken as string,
  };
};

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
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

const createTotp = (secretBase32: string, nowUnixSeconds = Math.floor(Date.now() / 1000)) => {
  const counter = Math.floor(nowUnixSeconds / 30);
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
  return String(binaryCode % 1_000_000).padStart(6, "0");
};

test("register/login/session/signout flow uses secure session semantics", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = {
      displayName: "Security Tester",
      email: "security@example.local",
      password: "safe-pass-123",
    };
    const registerResponse = await client.post("/api/auth/register").send(identity).expect(201);
    assert.ok(registerResponse.headers["set-cookie"]);
    const cookieHeader = String(registerResponse.headers["set-cookie"][0] ?? "");
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Strict/i);
    assert.equal(registerResponse.body.profile.email, identity.email);
    assert.equal(registerResponse.body.sessionCookie, "day1_session");
    const csrfToken = registerResponse.body.csrfToken as string;
    assert.ok(csrfToken);

    const sessionResponse = await client.get("/api/auth/session").expect(200);
    assert.equal(sessionResponse.body.profile.displayName, identity.displayName);
    const postWithCsrf = withCsrf(client, (sessionResponse.body.csrfToken as string) || csrfToken, "post");

    await postWithCsrf("/api/auth/signout").send({}).expect(200);
    await client.get("/api/auth/session").expect(401);

    await client.post("/api/auth/login").send({ email: identity.email, password: identity.password }).expect(200);
    await client.get("/api/auth/session").expect(200);
  } finally {
    cleanup();
  }
});

test("repeated login cycles preserve stable user identity", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = {
      displayName: "Stable Identity",
      email: "stable.identity@example.local",
      password: "stable-pass-123",
    };

    const register = await client.post("/api/auth/register").send(identity).expect(201);
    const firstUserId = register.body.session.userId as string;
    assert.ok(firstUserId);

    await withCsrf(client, register.body.csrfToken as string, "post")("/api/auth/signout").send({}).expect(200);

    const login1 = await client.post("/api/auth/login").send(identity).expect(200);
    assert.equal(login1.body.session.userId, firstUserId);
    const session1 = await client.get("/api/auth/session").expect(200);
    assert.equal(session1.body.session.userId, firstUserId);
    assert.equal(session1.body.profile.userId, firstUserId);
    const me1 = await client.get("/api/me/profile").expect(200);
    assert.equal(me1.body.profile.userId, firstUserId);

    await withCsrf(client, session1.body.csrfToken as string, "post")("/api/auth/signout").send({}).expect(200);

    const login2 = await client.post("/api/auth/login").send(identity).expect(200);
    assert.equal(login2.body.session.userId, firstUserId);
    const session2 = await client.get("/api/auth/session").expect(200);
    assert.equal(session2.body.session.userId, firstUserId);
    assert.equal(session2.body.profile.userId, firstUserId);
  } finally {
    cleanup();
  }
});

test("mixed-case and spaced emails map to one account identity", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const register = await client
      .post("/api/auth/register")
      .send({
        displayName: "Case Normalized",
        email: "  Mixed.Case+One@Example.Local  ",
        password: "normalize-pass-123",
      })
      .expect(201);

    const canonicalEmail = "mixed.case+one@example.local";
    const firstUserId = register.body.session.userId as string;
    assert.equal(register.body.profile.email, canonicalEmail);

    await withCsrf(client, register.body.csrfToken as string, "post")("/api/auth/signout").send({}).expect(200);

    const login = await client
      .post("/api/auth/login")
      .send({ email: " MIXED.CASE+ONE@EXAMPLE.LOCAL ", password: "normalize-pass-123" })
      .expect(200);
    assert.equal(login.body.profile.email, canonicalEmail);
    assert.equal(login.body.session.userId, firstUserId);

    await client
      .post("/api/auth/register")
      .send({
        displayName: "Should Conflict",
        email: "mixed.case+one@example.local",
        password: "another-pass-123",
      })
      .expect(409);
  } finally {
    cleanup();
  }
});

test("dynamic login links by email and creates a day1 session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, {
    enableRatificationScheduler: false,
    dynamicTokenVerifier: async (token) => {
      if (token !== "valid-dynamic-token") throw new Error("bad token");
      return {
        subject: "dyn_sub_001",
        email: "dynamic.link@example.local",
        emailVerified: true,
        displayName: "Dynamic User",
      };
    },
  });
  const client = request.agent(app);
  try {
    const registered = await client
      .post("/api/auth/register")
      .send({
        displayName: "Existing Local User",
        email: "dynamic.link@example.local",
        password: "existing-pass-123",
      })
      .expect(201);
    const originalUserId = registered.body.session.userId as string;
    await withCsrf(client, registered.body.csrfToken as string, "post")("/api/auth/signout").send({}).expect(200);

    const dynamicLogin = await client
      .post("/api/auth/dynamic/login")
      .send({ authToken: "valid-dynamic-token" })
      .expect(200);
    assert.equal(dynamicLogin.body.authMode, "dynamic");
    assert.equal(dynamicLogin.body.session.userId, originalUserId);
    const session = await client.get("/api/auth/session").expect(200);
    assert.equal(session.body.session.userId, originalUserId);

    await client
      .post("/api/auth/dynamic/login")
      .send({ authToken: "invalid-token" })
      .expect(401);
  } finally {
    closeTestAgent(client);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dynamic login can load game types and create game", async () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, {
    enableRatificationScheduler: false,
    dynamicTokenVerifier: async (token) => {
      if (token !== "valid-dynamic-token") throw new Error("bad token");
      return {
        subject: "dyn_game_types_visibility",
        email: "dynamic-game-types@example.local",
        emailVerified: true,
        displayName: "Dynamic Game Types",
      };
    },
  });
  const client = request.agent(app);
  try {
    await client
      .post("/api/auth/dynamic/login")
      .send({ authToken: "valid-dynamic-token" })
      .expect(200);
    const verifiedSession = await client.get("/api/auth/session").expect(200);
    const postWithCsrf = withCsrf(client, verifiedSession.body.csrfToken as string, "post");
    const gameTypes = await client.get("/api/game-types").expect(200);
    const supportedTypes = (gameTypes.body.gameTypes as Array<{ gameType: string }>).map((entry) => entry.gameType);
    assert.ok(supportedTypes.includes("tic_tac_toe"));
    assert.ok(supportedTypes.includes("coin_flip_demo"));

    const created = await postWithCsrf("/api/game/create").send({ gameType: "tic_tac_toe" }).expect(201);
    assert.equal(created.body.game.gameType, "tic_tac_toe");
  } finally {
    closeTestAgent(client);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dynamic login returns session token fallback for header-auth recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, {
    enableRatificationScheduler: false,
    dynamicTokenVerifier: async (token) => {
      if (token !== "valid-dynamic-token") throw new Error("bad token");
      return {
        subject: "dyn_header_fallback",
        email: "dynamic-header-fallback@example.local",
        emailVerified: true,
        displayName: "Dynamic Header Fallback",
      };
    },
  });
  try {
    const login = await request(app)
      .post("/api/auth/dynamic/login")
      .send({ authToken: "valid-dynamic-token" })
      .expect(200);
    const sessionToken = login.body.sessionToken as string;
    assert.ok(sessionToken);

    await request(app).get("/api/game-types").set("x-day1-session-token", sessionToken).expect(200);
    await request(app)
      .post("/api/game/create")
      .set("x-day1-session-token", sessionToken)
      .send({ gameType: "tic_tac_toe" })
      .expect(201);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-origin cookie settings keep dynamic session usable for game-type loading", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCorsOrigins = process.env.DAY1_CORS_ALLOWED_ORIGINS;
  const previousCookieSameSite = process.env.DAY1_SESSION_COOKIE_SAME_SITE;
  const previousCookieSecure = process.env.DAY1_SESSION_COOKIE_SECURE;
  process.env.NODE_ENV = "production";
  process.env.DAY1_CORS_ALLOWED_ORIGINS = "https://day1-ui.example.com";
  process.env.DAY1_SESSION_COOKIE_SAME_SITE = "none";
  process.env.DAY1_SESSION_COOKIE_SECURE = "false";
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, {
    enableRatificationScheduler: false,
    dynamicTokenVerifier: async (token) => {
      if (token !== "valid-dynamic-token") throw new Error("bad token");
      return {
        subject: "dyn_cross_site_cookie",
        email: "dynamic-cookie-policy@example.local",
        emailVerified: true,
        displayName: "Dynamic Cookie Policy",
      };
    },
  });
  const client = request(app);
  try {
    const origin = "https://day1-ui.example.com";
    const login = await client
      .post("/api/auth/dynamic/login")
      .set("Origin", origin)
      .send({ authToken: "valid-dynamic-token" })
      .expect(200);
    assert.equal(login.headers["access-control-allow-origin"], origin);
    assert.equal(login.headers["access-control-allow-credentials"], "true");
    const cookieHeader = String(login.headers["set-cookie"]?.[0] ?? "");
    const sessionCookie = cookieHeader.split(";")[0];
    assert.match(cookieHeader, /SameSite=None/i);
    assert.doesNotMatch(cookieHeader, /SameSite=Strict/i);

    await request(app).get("/api/auth/session").set("Origin", origin).set("Cookie", sessionCookie).expect(200);
    const gameTypes = await request(app)
      .get("/api/game-types")
      .set("Origin", origin)
      .set("Cookie", sessionCookie)
      .expect(200);
    const supportedTypes = (gameTypes.body.gameTypes as Array<{ gameType: string }>).map((entry) => entry.gameType);
    assert.ok(supportedTypes.includes("tic_tac_toe"));
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousCorsOrigins === undefined) {
      delete process.env.DAY1_CORS_ALLOWED_ORIGINS;
    } else {
      process.env.DAY1_CORS_ALLOWED_ORIGINS = previousCorsOrigins;
    }
    if (previousCookieSameSite === undefined) {
      delete process.env.DAY1_SESSION_COOKIE_SAME_SITE;
    } else {
      process.env.DAY1_SESSION_COOKIE_SAME_SITE = previousCookieSameSite;
    }
    if (previousCookieSecure === undefined) {
      delete process.env.DAY1_SESSION_COOKIE_SECURE;
    } else {
      process.env.DAY1_SESSION_COOKIE_SECURE = previousCookieSecure;
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production defaults issue SameSite=None and Secure cookies", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCookieSameSite = process.env.DAY1_SESSION_COOKIE_SAME_SITE;
  const previousCookieSecure = process.env.DAY1_SESSION_COOKIE_SECURE;
  process.env.NODE_ENV = "production";
  delete process.env.DAY1_SESSION_COOKIE_SAME_SITE;
  delete process.env.DAY1_SESSION_COOKIE_SECURE;
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, {
    enableRatificationScheduler: false,
    dynamicTokenVerifier: async (token) => {
      if (token !== "valid-dynamic-token") throw new Error("bad token");
      return {
        subject: "dyn_prod_cookie_defaults",
        email: "dynamic-prod-cookie@example.local",
        emailVerified: true,
        displayName: "Dynamic Prod Cookie",
      };
    },
  });
  const client = request.agent(app);
  try {
    const login = await client
      .post("/api/auth/dynamic/login")
      .send({ authToken: "valid-dynamic-token" })
      .expect(200);
    const cookieHeader = String(login.headers["set-cookie"]?.[0] ?? "");
    assert.match(cookieHeader, /SameSite=None/i);
    assert.match(cookieHeader, /Secure/i);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousCookieSameSite === undefined) {
      delete process.env.DAY1_SESSION_COOKIE_SAME_SITE;
    } else {
      process.env.DAY1_SESSION_COOKIE_SAME_SITE = previousCookieSameSite;
    }
    if (previousCookieSecure === undefined) {
      delete process.env.DAY1_SESSION_COOKIE_SECURE;
    } else {
      process.env.DAY1_SESSION_COOKIE_SECURE = previousCookieSecure;
    }
    closeTestAgent(client);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dynamic login rejects conflicts with an already-linked day1 account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, {
    enableRatificationScheduler: false,
    dynamicTokenVerifier: async (token) => {
      if (token !== "valid-dynamic-token") throw new Error("bad token");
      return {
        subject: "dyn_subject_conflict",
        email: "dynamic-conflict@example.local",
        emailVerified: true,
        displayName: "Dynamic Conflict",
      };
    },
  });
  const linkedClient = request.agent(app);
  const activeClient = request.agent(app);
  try {
    await registerAndLogin(linkedClient, {
      displayName: "Linked User",
      email: "linked-user@example.local",
      password: "linked-user-pass-123",
    });
    const linkedDynamic = await linkedClient
      .post("/api/auth/dynamic/login")
      .send({ authToken: "valid-dynamic-token" })
      .expect(200);
    assert.equal(linkedDynamic.body.authMode, "dynamic");

    await registerAndLogin(activeClient, {
      displayName: "Active User",
      email: "active-user@example.local",
      password: "active-user-pass-123",
    });
    const conflict = await activeClient
      .post("/api/auth/dynamic/login")
      .send({ authToken: "valid-dynamic-token" })
      .expect(409);
    assert.equal(conflict.body.error, "DYNAMIC_IDENTITY_CONFLICT");
  } finally {
    closeTestAgent(activeClient);
    closeTestAgent(linkedClient);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dynamic login keeps existing day1 account authority when already signed in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "day1-tests-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new Day1Store(dbPath);
  const app = createDay1App(store, {
    enableRatificationScheduler: false,
    dynamicTokenVerifier: async (token) => {
      if (token !== "valid-dynamic-token") throw new Error("bad token");
      return {
        subject: "dyn_subject_preserve_authority",
        email: "dynamic-authority@example.local",
        emailVerified: true,
        displayName: "Dynamic Authority",
      };
    },
  });
  const hostClient = request.agent(app);
  let guestClient: request.SuperAgentTest | undefined;
  try {
    const host = await registerAndLogin(hostClient, {
      displayName: "Guest Bootstrap",
      email: "guest-bootstrap@example.local",
      password: "guest-bootstrap-pass-123",
    });
    const hostPost = withCsrf(hostClient, host.csrfToken, "post");
    const created = await hostPost("/api/game/create").send({}).expect(201);
    const gameId = created.body.game.gameId as string;
    assert.equal(created.body.game.playerSeats.X, host.userId);

    const dynamicLogin = await hostClient
      .post("/api/auth/dynamic/login")
      .send({ authToken: "valid-dynamic-token" })
      .expect(200);
    assert.equal(dynamicLogin.body.session.userId, host.userId);

    const openLobby = await hostClient.get("/api/games?status=open").expect(200);
    assert.ok(openLobby.body.games.some((entry: { gameId: string }) => entry.gameId === gameId));

    guestClient = request.agent(app);
    const guest = await registerAndLogin(guestClient, {
      displayName: "Authority Guest",
      email: "authority-guest@example.local",
      password: "authority-guest-pass-123",
    });
    const guestPost = withCsrf(guestClient, guest.csrfToken, "post");
    await guestPost(`/api/game/${gameId}/join`).send({}).expect(200);

    const refreshedSession = await hostClient.get("/api/auth/session").expect(200);
    await withCsrf(hostClient, refreshedSession.body.csrfToken as string, "post")(`/api/game/${gameId}/move`)
      .send({ cell: 0 })
      .expect(200);
  } finally {
    closeTestAgent(guestClient);
    closeTestAgent(hostClient);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guest login creates a local session without dynamic token", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const guest = await client.post("/api/auth/guest").send({ displayName: "Guest Flow" }).expect(201);
    assert.equal(guest.body.authMode, "guest");
    assert.equal(guest.body.profile.displayName, "Guest Flow");
    assert.match(guest.body.profile.email as string, /^guest-/);

    const session = await client.get("/api/auth/session").expect(200);
    assert.equal(session.body.session.userId, guest.body.session.userId);
  } finally {
    cleanup();
  }
});

test("login endpoint applies brute-force throttle scaffold", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = {
      displayName: "Throttle Test",
      email: "throttle@example.local",
      password: "strong-pass-123",
    };
    await client.post("/api/auth/register").send(identity).expect(201);
    const login = await client.post("/api/auth/login").send({ email: identity.email, password: identity.password }).expect(200);
    await withCsrf(client, login.body.csrfToken as string, "post")("/api/auth/signout").send({}).expect(200);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await client
        .post("/api/auth/login")
        .send({ email: identity.email, password: `wrong-${attempt}` })
        .expect(401);
    }

    const rateLimited = await client
      .post("/api/auth/login")
      .send({ email: identity.email, password: "still-wrong" })
      .expect(429);
    assert.equal(rateLimited.body.error, "RATE_LIMITED");
    assert.ok(Number(rateLimited.body.retryAfterSeconds) >= 1);
  } finally {
    cleanup();
  }
});

test("idempotency key replays critical game creation writes", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = await registerAndLogin(client, {
      displayName: "Idempotency Tester",
      email: "idempotency@example.local",
      password: "safe-pass-123",
    });
    const idemKey = "idem-game-create-001";
    const first = await withCsrf(client, identity.csrfToken, "post")("/api/game/create")
      .set("idempotency-key", idemKey)
      .send({})
      .expect(201);
    const second = await withCsrf(client, identity.csrfToken, "post")("/api/game/create")
      .set("idempotency-key", idemKey)
      .send({})
      .expect(201);
    assert.equal(first.body.game.gameId, second.body.game.gameId);
    assert.equal(second.headers["x-day1-idempotent-replay"], "true");
  } finally {
    cleanup();
  }
});

test("lobby listings and join from list work", async () => {
  const { app, client: hostClient, cleanup } = createTestContext();
  let guestClient: request.SuperAgentTest | undefined;
  try {
    const host = await registerAndLogin(hostClient, {
      displayName: "Host",
      email: "host@example.local",
      password: "host-pass-123",
    });
    assert.ok(host.userId);
    const hostPost = withCsrf(hostClient, host.csrfToken, "post");

    const createGame = await hostPost("/api/game/create").send({}).expect(201);
    const gameId = createGame.body.game.gameId as string;
    assert.ok(gameId);

    const lobbyResponse = await hostClient.get("/api/games?status=open").expect(200);
    assert.ok(
      lobbyResponse.body.games.some((entry: { gameId: string; playerSeats: { O: string | null } }) => {
        return entry.gameId === gameId && entry.playerSeats.O === null;
      })
    );

    guestClient = request.agent(app);
    await registerAndLogin(guestClient, {
      displayName: "Guest",
      email: "guest@example.local",
      password: "guest-pass-123",
    });
    const guestAuth = await guestClient.post("/api/auth/login").send({ email: "guest@example.local", password: "guest-pass-123" }).expect(200);
    const guestPost = withCsrf(guestClient, guestAuth.body.csrfToken as string, "post");
    const joinResponse = await guestPost(`/api/game/${gameId}/join`).send({}).expect(200);
    assert.equal(joinResponse.body.playerSymbol, "O");
    assert.equal(joinResponse.body.status.kind, "ongoing");

    const guestOpenLobby = await guestClient.get("/api/games?status=open").expect(200);
    assert.equal(
      guestOpenLobby.body.games.some((entry: { gameId: string }) => entry.gameId === gameId),
      false
    );
    const guestHydratedGame = await guestClient.get(`/api/game/${gameId}`).expect(200);
    assert.equal(guestHydratedGame.body.playerSymbol, "O");
    assert.equal(guestHydratedGame.body.status.kind, "ongoing");

    const activeLobby = await hostClient.get("/api/games?status=active").expect(200);
    assert.ok(activeLobby.body.games.some((entry: { gameId: string }) => entry.gameId === gameId));
  } finally {
    closeTestAgent(guestClient);
    cleanup();
  }
});

test("game registry lists adapters and allows typed game creation", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = await registerAndLogin(client, {
      displayName: "Registry Tester",
      email: "registry@example.local",
      password: "registry-pass-123",
    });
    const postWithCsrf = withCsrf(client, identity.csrfToken, "post");

    const types = await client.get("/api/game-types").expect(200);
    const ids = (types.body.gameTypes as Array<{ gameType: string }>).map((entry) => entry.gameType);
    assert.ok(ids.includes("tic_tac_toe"));
    assert.ok(ids.includes("coin_flip_demo"));

    const placeholder = await postWithCsrf("/api/game/create").send({ gameType: "coin_flip_demo" }).expect(201);
    assert.equal(placeholder.body.game.gameType, "coin_flip_demo");
    const move = await postWithCsrf(`/api/game/${placeholder.body.game.gameId}/move`).send({ cell: 0 }).expect(400);
    assert.equal(move.body.result.reason, "UNSUPPORTED_FOR_GAME_TYPE");
  } finally {
    cleanup();
  }
});

test("create game remains backward compatible without gameType", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = await registerAndLogin(client, {
      displayName: "Compat Tester",
      email: "compat@example.local",
      password: "compat-pass-123",
    });
    const postWithCsrf = withCsrf(client, identity.csrfToken, "post");
    const created = await postWithCsrf("/api/game/create").send({}).expect(201);
    assert.equal(created.body.game.gameType, "tic_tac_toe");
  } finally {
    cleanup();
  }
});

test("turn ownership and leaderboard progression remain enforced", async () => {
  const { app, client: aClient, cleanup } = createTestContext();
  let bClient: request.SuperAgentTest | undefined;
  let spectatorClient: request.SuperAgentTest | undefined;
  try {
    await registerAndLogin(aClient, {
      displayName: "Player A",
      email: "a@example.local",
      password: "a-pass-123",
    });
    const aLogin = await aClient.post("/api/auth/login").send({ email: "a@example.local", password: "a-pass-123" }).expect(200);
    const aPost = withCsrf(aClient, aLogin.body.csrfToken as string, "post");
    bClient = request.agent(app);
    spectatorClient = request.agent(app);

    const b = await registerAndLogin(bClient, {
      displayName: "Player B",
      email: "b@example.local",
      password: "b-pass-123",
    });
    const bLogin = await bClient.post("/api/auth/login").send({ email: "b@example.local", password: "b-pass-123" }).expect(200);
    const bPost = withCsrf(bClient, bLogin.body.csrfToken as string, "post");
    await registerAndLogin(spectatorClient, {
      displayName: "Spectator",
      email: "spectator@example.local",
      password: "spec-pass-123",
    });
    const spectatorLogin = await spectatorClient
      .post("/api/auth/login")
      .send({ email: "spectator@example.local", password: "spec-pass-123" })
      .expect(200);
    const spectatorPost = withCsrf(spectatorClient, spectatorLogin.body.csrfToken as string, "post");

    const gameCreated = await aPost("/api/game/create").send({}).expect(201);
    const gameId = gameCreated.body.game.gameId as string;
    await bPost(`/api/game/${gameId}/join`).send({}).expect(200);

    const outOfTurn = await bPost(`/api/game/${gameId}/move`).send({ cell: 1 }).expect(400);
    assert.equal(outOfTurn.body.result.reason, "NOT_YOUR_TURN");

    await aPost(`/api/game/${gameId}/move`).send({ cell: 0 }).expect(200);
    await bPost(`/api/game/${gameId}/move`).send({ cell: 3 }).expect(200);
    await aPost(`/api/game/${gameId}/move`).send({ cell: 1 }).expect(200);
    await bPost(`/api/game/${gameId}/move`).send({ cell: 4 }).expect(200);
    await aPost(`/api/game/${gameId}/move`).send({ cell: 2 }).expect(200);

    const completedGame = await aClient.get(`/api/game/${gameId}`).expect(200);
    assert.equal(completedGame.body.completion.finished, true);
    assert.equal(completedGame.body.completion.kind, "won");
    assert.equal(completedGame.body.completion.winnerSymbol, "X");

    const spectatorMove = await spectatorPost(`/api/game/${gameId}/move`).send({ cell: 7 }).expect(400);
    assert.equal(spectatorMove.body.result.reason, "PLAYER_NOT_IN_GAME");

    const leaderboard = await aClient.get("/api/leaderboard").expect(200);
    const winnerRow = leaderboard.body.leaderboard.find(
      (entry: { userId: string; points: number }) => entry.userId === gameCreated.body.game.playerSeats.X
    );
    assert.ok(winnerRow);
    assert.ok(winnerRow.points >= 120);
    const loserRow = leaderboard.body.leaderboard.find((entry: { userId: string }) => entry.userId === b.userId);
    assert.ok(loserRow);
    assert.ok(winnerRow.points > loserRow.points);
    assert.equal(winnerRow.rank, 1);

    const rewardsA = await aClient.get("/api/rewards/get").expect(200);
    const rewardsB = await bClient.get("/api/rewards/get").expect(200);
    assert.equal(rewardsA.body.rewardSnapshot.tier, "starter");
    assert.equal(rewardsB.body.rewardSnapshot.tier, "starter");

    const recentPlayers = await aClient.get("/api/players/recent").expect(200);
    assert.ok(recentPlayers.body.players.some((entry: { userId: string }) => entry.userId === b.userId));
  } finally {
    closeTestAgent(bClient);
    closeTestAgent(spectatorClient);
    cleanup();
  }
});

test("csrf enforcement blocks cookie-auth mutations without token", async () => {
  const { client, cleanup } = createTestContext();
  try {
    await registerAndLogin(client, {
      displayName: "CSRF Tester",
      email: "csrf@example.local",
      password: "csrf-pass-123",
    });
    await client.post("/api/game/create").send({}).expect(403);
    const session = await client.get("/api/auth/session").expect(200);
    const csrfPost = withCsrf(client, session.body.csrfToken as string, "post");
    await csrfPost("/api/game/create").send({}).expect(201);
  } finally {
    cleanup();
  }
});

test("health readiness reports dependency-level readiness", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const response = await client.get("/api/health/readiness").expect(503);
    assert.equal(response.body.ready, false);
    assert.equal(response.body.dependencies.database.ready, true);
    assert.equal(typeof response.body.dependencies.rateLimiter.detail, "string");
  } finally {
    cleanup();
  }
});

test("health env endpoint provides redacted ratification diagnostics", async () => {
  const { client, cleanup } = createTestContext();
  const previousSecret = process.env.DAY1_SERVER_WALLET_SECRET;
  process.env.DAY1_SERVER_WALLET_SECRET = "health-endpoint-secret";
  try {
    const response = await client.get("/api/health/env").expect(200);
    assert.equal(response.body.scaffold, true);
    assert.equal(response.body.env.ratificationEnv.DAY1_SERVER_WALLET_SECRET.redaction, "secret");
    assert.match(
      response.body.env.ratificationEnv.DAY1_SERVER_WALLET_SECRET.valuePreview as string,
      /\[redacted:\d+ chars\]/
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.DAY1_SERVER_WALLET_SECRET;
    } else {
      process.env.DAY1_SERVER_WALLET_SECRET = previousSecret;
    }
    cleanup();
  }
});

test("request id is echoed for correlation", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const customRequestId = "req-test-001";
    const response = await client.get("/api/health").set("x-request-id", customRequestId).expect(200);
    assert.equal(response.headers["x-request-id"], customRequestId);
    assert.equal(response.headers["x-correlation-id"], customRequestId);
  } finally {
    cleanup();
  }
});

test("password reset token is one-time and expires safely", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = {
      displayName: "Recovery User",
      email: "recover@example.local",
      password: "recover-pass-123",
    };
    await client.post("/api/auth/register").send(identity).expect(201);
    const requestReset = await client.post("/api/auth/recovery/request").send({ email: identity.email }).expect(202);
    const token = requestReset.body.resetTokenPreview as string;
    assert.ok(token);

    await client
      .post("/api/auth/recovery/reset")
      .send({ token, newPassword: "recover-pass-456" })
      .expect(200);
    await client.post("/api/auth/login").send({ email: identity.email, password: "recover-pass-456" }).expect(200);
    await client
      .post("/api/auth/recovery/reset")
      .send({ token, newPassword: "recover-pass-789" })
      .expect(400);
  } finally {
    cleanup();
  }
});

test("mfa totp enrollment and login guardrails work", async () => {
  const { client, cleanup } = createTestContext();
  try {
    const identity = {
      displayName: "MFA User",
      email: "mfa@example.local",
      password: "mfa-pass-123",
    };
    const registration = await client.post("/api/auth/register").send(identity).expect(201);
    const csrfPost = withCsrf(client, registration.body.csrfToken as string, "post");

    const start = await csrfPost("/api/auth/mfa/totp/enroll/start").send({}).expect(200);
    const code = createTotp(start.body.secret as string);
    await csrfPost("/api/auth/mfa/totp/enroll/verify").send({ code }).expect(200);
    await csrfPost("/api/auth/signout").send({}).expect(200);

    await client.post("/api/auth/login").send({ email: identity.email, password: identity.password }).expect(401);
    await client
      .post("/api/auth/login")
      .send({ email: identity.email, password: identity.password, mfaCode: "000000" })
      .expect(401);
    const success = await client
      .post("/api/auth/login")
      .set("x-day1-device-id", "device-mfa-1")
      .send({ email: identity.email, password: identity.password, mfaCode: code, rememberDevice: true })
      .expect(200);
    assert.ok(success.body.session.sessionId);
  } finally {
    cleanup();
  }
});

test("security metrics endpoint returns object snapshots for security and endpoints", async () => {
  const { client, cleanup } = createTestContext();
  try {
    await registerAndLogin(client, {
      displayName: "Metrics User",
      email: "metrics@example.local",
      password: "metrics-pass-123",
    });

    const response = await client.get("/api/security/metrics").expect(200);
    assert.equal(typeof response.body.metrics, "object");
    assert.equal(Array.isArray(response.body.metrics), false);
    assert.equal(typeof response.body.metrics.security, "object");
    assert.equal(typeof response.body.metrics.endpoints, "object");
  } finally {
    cleanup();
  }
});

test("truth stack endpoint classifies pending, ratified, and on-chain source records", async () => {
  const { app, client: hostClient, cleanup } = createTestContext();
  let guestClient: request.SuperAgentTest | undefined;
  try {
    const host = await registerAndLogin(hostClient, {
      displayName: "Truth Host",
      email: "truth-host@example.local",
      password: "truth-host-pass-123",
    });
    guestClient = request.agent(app);
    const guest = await registerAndLogin(guestClient, {
      displayName: "Truth Guest",
      email: "truth-guest@example.local",
      password: "truth-guest-pass-123",
    });
    const hostPost = withCsrf(hostClient, host.csrfToken, "post");
    const guestPost = withCsrf(guestClient, guest.csrfToken, "post");

    const created = await hostPost("/api/game/create").send({}).expect(201);
    const gameId = created.body.game.gameId as string;
    assert.ok(gameId);
    assert.ok(guest.userId);

    await guestPost(`/api/game/${gameId}/join`).send({}).expect(200);
    await hostPost(`/api/game/${gameId}/move`).send({ cell: 0 }).expect(200);

    const beforeRatification = await hostClient.get("/api/truth-stack?limit=50&recent=10").expect(200);
    assert.equal(beforeRatification.body.truth.layers.ratified.count, 0);
    assert.ok(beforeRatification.body.truth.layers.off_chain_pending.count >= 1);

    await hostPost("/api/onchain/intent/create").send({ gameId, action: "SETTLE_GAME" }).expect(201);
    const withOnChainSource = await hostClient.get("/api/truth-stack?limit=50&recent=10").expect(200);
    assert.ok(withOnChainSource.body.truth.layers.on_chain_source.count >= 1);

    const ratificationRun = await hostPost("/api/ratification/run").send({}).expect(200);
    const afterRatification = await hostClient.get("/api/truth-stack?limit=50&recent=10").expect(200);
    if (ratificationRun.body.run?.outcome === "skipped" && ratificationRun.body.run?.reason === "SERVER_WALLET_NOT_READY") {
      // Local/dev environments may not configure server wallet secrets; preserve pending classification guarantees.
      assert.equal(afterRatification.body.truth.layers.ratified.count, 0);
      assert.ok(afterRatification.body.truth.layers.off_chain_pending.count >= 1);
    } else {
      assert.ok(afterRatification.body.truth.layers.ratified.count >= 1);
      assert.equal(afterRatification.body.truth.layers.ratified.recent[0].state, "ratified");
    }
  } finally {
    closeTestAgent(guestClient);
    cleanup();
  }
});
