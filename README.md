# Ergo Games Day 1

No-wager local-first MVP foundation for Tic-Tac-Toe with:

- React client (`src/`)
- Express API (`server/`)
- deterministic game rules from `@twobitedd/ergo-games-interface`
- shared account abstraction/session derivation from `@twobitedd/ergo-account-model`
- persistent SQLite state (`.day1-data/day1.sqlite`)

## Primetime-Foundation Hardening Included

- Persistent storage for accounts, sessions, games, moves/events, rewards, and leaderboard stats
- Dynamic-first auth bridge with guest fallback bootstrap
- Legacy `register` / `login` auth routes retained for compatibility/testing
- Password hashing via Node `scrypt` (salted)
- Cookie-backed session handling (HTTP-only, same-site, secure in production mode)
- CSRF token issuance + validation on cookie-authenticated mutating routes
- Session token length guard + expired-session purge on auth paths
- Basic brute-force/rate-limit scaffolding for register/login
- Rate-limiter adapter seam (`sqlite` default + redis-capable scaffold mode)
- Account recovery scaffold with hashed one-time reset tokens and TTL
- TOTP MFA enrollment/verification foundations + trusted device/session scaffolding
- Structured security event logging + baseline security metric counters
- Structured request logs with request/correlation ids and endpoint latency/error counters
- Defensive API security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`)
- Account identity separated from optional wallet binding
- Lobby/game listing endpoint and UI flow for create/join from list
- Multi-game runtime registry with typed adapters (`tic_tac_toe` + `coin_flip_demo` placeholder)
- Shared runtime interfaces for `GameEngine`, `GameSessionService`, `RewardPolicy`, and `SettlementPolicy`
- SDK-level typed integration contracts from `@twobitedd/ergo-games-interface`
- Known players (recent activity) endpoint + UI
- Leaderboard endpoint + UI
- Existing authoritative gameplay constraints preserved (seat ownership, turn enforcement, completion/reward handling)

## How Day1 Works With Shared Packages

Flow (text diagram):

1. **Identity/session layer** -> UI and server consume `@twobitedd/ergo-account-model` for account-session shaping, canonical account state snapshots (`GUEST | REGISTERED | WALLET_BOUND`), conversion posture, and portable export artifacts.
2. **Domain/rules layer** -> Day1 consumes `@twobitedd/ergo-games-interface` for game contracts (`GameType`, status shapes) and deterministic rule evaluation (`statusOf`, move application).
3. **Composition layer (Day1 app)** -> Day1 API/runtime/store orchestrate auth, lobby, persistence, and ratification around those package contracts without redefining core account or game-domain semantics.
4. **Persistence + transport adapters** -> SQLite, Express routes, and UI polling remain app-local integration concerns and do not become shared domain sources.

## API Overview

### Auth and account

- `POST /api/auth/dynamic/login` (primary)
- `POST /api/auth/guest` (guest fallback)
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/sync` (legacy bootstrap compatibility)
- `POST /api/auth/csrf` (rotate CSRF token for cookie-auth clients)
- `POST /api/auth/recovery/request`
- `POST /api/auth/recovery/reset`
- `POST /api/auth/mfa/totp/enroll/start`
- `POST /api/auth/mfa/totp/enroll/verify`
- `POST /api/auth/mfa/totp/disable`
- `GET /api/auth/session`
- `POST /api/auth/signout`
- `GET /api/me/profile`
- `POST /api/wallet/bind` (optional wallet binding)
- `GET /api/security/devices`
- `POST /api/security/devices/trust`
- `POST /api/security/devices/:deviceId/revoke`
- `GET /api/security/sessions`
- `POST /api/security/sessions/:sessionId/revoke`
- `GET /api/security/events`
- `GET /api/security/metrics`

### Game and lobby

- `GET /api/game-types`
- `POST /api/game/create`
- `POST /api/game/:gameId/join`
- `GET /api/games?status=all|open|active|completed`
- `GET /api/game/:gameId`
- `POST /api/game/:gameId/move`

### Progression

- `GET /api/rewards/get`
- `GET /api/players/recent`
- `GET /api/leaderboard`

### On-chain intent scaffold

- `POST /api/onchain/intent/create`
- `GET /api/onchain/intent/:intentId/status`

### Ratification and server wallet

- `GET /api/health`
- `GET /api/health/readiness`
- `GET /api/server-wallet/status`
- `GET /api/ratification/schedule`
- `POST /api/ratification/schedule` (guarded by env flag)
- `POST /api/ratification/run`
- `GET /api/ratification/batches?limit=25`

## Local Setup / DB Init / Run

From `ergo-games-day1`:

```bash
npm install
cp .env.example .env.local
npm run db:init
npm run dev
```

### Dynamic-first + guest fallback

Day1 setup is now intentionally Dynamic-first:

1. Authenticate in Dynamic widget (primary path), then click `Dynamic -> Day1 Session`.
2. If Dynamic is unavailable/misconfigured, use `Continue as Guest` to bootstrap a local guest session.

Legacy email/password endpoints still exist for compatibility and tests, but they are no longer part of the main Day1 setup UX.

Minimal required env vars for Dynamic-first:

```bash
DAY1_DYNAMIC_AUTH_ENABLED=true
DAY1_DYNAMIC_JWT_ISSUER=<issuer-from-dynamic>
DAY1_DYNAMIC_JWT_AUDIENCE=<audience-from-dynamic>
DAY1_DYNAMIC_JWKS_URL=<jwks-url-from-dynamic>
VITE_DAY1_DYNAMIC_ENABLED=true
VITE_DYNAMIC_ENVIRONMENT_ID=<dynamic-environment-id>
```

### Railway/npm dependency strings

For Railway (or any non-monorepo install), use published package versions instead of local `file:` links:

```json
{
  "@twobitedd/ergo-account-model": "^0.1.1",
  "@twobitedd/ergo-games-interface": "^0.1.1"
}
```

This repository now uses published semver dependencies by default. For local workspace development, `npm run sync:account-model` automatically rebuilds the sibling package when it exists.

### Development env loading (`.env.local` support)

Server entrypoints (`npm run dev:server`, `npm run dev`, and `npm run db:init`) now load env files in this order:

1. shell/exported environment variables (highest priority, never overwritten),
2. `.env.local`,
3. `.env`.

This means:

- set one-off overrides directly in your shell when needed,
- keep machine-specific values in `.env.local`,
- keep shared defaults in `.env`.

Example:

```bash
# shell value wins over both files
DAY1_CHAIN_MODE=ergo npm run dev:server
```

To verify ratification-related env without leaking secrets:

```bash
curl -s http://localhost:4010/api/health/env
```

`/api/health/env` returns redacted/masked diagnostics for ratification-relevant env keys and reports which env files were loaded by the server process.

Default runtime ports:

- API: `http://localhost:4010`
- frontend: `http://localhost:5173`

Optional DB path override:

```bash
DAY1_DB_PATH=/absolute/path/to/day1.sqlite npm run dev:server
```

Ratification + wallet environment (safe defaults):

```bash
# Required for ratification execution
DAY1_SERVER_WALLET_ADDRESS=9...server_wallet_address...
DAY1_SERVER_WALLET_SECRET=replace_me_with_secure_secret

# Server wallet metadata
DAY1_CHAIN_MODE=ergo                 # ergo (default in .env.mainnet.example) or simulated
DAY1_CHAIN_NETWORK=mainnet           # mainnet default
DAY1_SERVER_WALLET_BALANCE_NANOERG=1000000000
DAY1_ERGO_SIGNING_MODE=external      # external (default), direct, or public-sponsor
DAY1_ERGO_NODE_URL=https://api-testnet.ergoplatform.com
DAY1_ERGO_EXPLORER_URL=https://api-testnet.ergoplatform.com
DAY1_RATIFY_FINALITY_DEPTH=6

# Ratification cadence and batching
DAY1_RATIFY_INTERVAL_MS=20000
DAY1_RATIFY_BATCH_MAX_RECORDS=50
DAY1_RATIFY_MIN_INTERVAL_MS=5000
DAY1_RATIFY_MAX_INTERVAL_MS=300000

# API override guard for runtime schedule changes
DAY1_RATIFY_ALLOW_API_OVERRIDE=false

# Rate limiter adapter mode
DAY1_RATE_LIMIT_ADAPTER=sqlite         # sqlite (default) or redis
DAY1_REDIS_URL=redis://localhost:6379  # scaffold input (sqlite fallback remains active)
```

Notes:

- `DAY1_SERVER_WALLET_SECRET` is loaded server-side only and never returned by API responses.
- In `DAY1_CHAIN_MODE=simulated`, ratification uses deterministic local submission + confirmation progression.
- In `DAY1_CHAIN_MODE=ergo`, ratification uses live HTTP adapters for submit/status polling with explicit config checks.
- `DAY1_ERGO_SIGNING_MODE=external` keeps manual signer handoff: batches move to `awaiting_signature` with a persisted signer payload, then are submitted through `POST /api/ratification/batches/:batchId/submit-signed`.
- `DAY1_ERGO_SIGNING_MODE=public-sponsor` keeps the same external payload handoff but labels the signer authority as public sponsor flow (useful when a sponsor service, not the local operator, signs).
- `DAY1_ERGO_SIGNING_MODE=direct` is reserved for in-process signing and disables manual signed batch submission in the UI.
- Confirmation progression is persisted per batch (`pending -> confirmed -> finalized`) with configurable finality depth and reorg flag shaping.
- Server refuses real-mode execution when required wallet and submit endpoint env is missing.
- `DAY1_RATE_LIMIT_ADAPTER=redis` currently enables distributed wiring shape and readiness visibility while preserving sqlite fallback behavior.

Optional env for deterministic TOTP secret encryption key (recommended outside local dev):

```bash
DAY1_TOTP_ENCRYPTION_KEY=replace-with-strong-key npm run dev:server
```

### Dynamic.xyz Login Bridge (Primary) + Guest Fallback

Day1 accepts a Dynamic auth JWT and converts it into the existing local Day1
cookie+CSRF session model. Dynamic is the primary onboarding/auth entry point
while local Day1 accounts/sessions remain authoritative and provider-agnostic.

Required env:

```bash
DAY1_DYNAMIC_AUTH_ENABLED=true
DAY1_DYNAMIC_JWT_ISSUER=<issuer-from-dynamic-jwt-settings>
DAY1_DYNAMIC_JWT_AUDIENCE=<audience-from-dynamic-jwt-settings>
DAY1_DYNAMIC_JWKS_URL=<jwks-url-from-dynamic-jwt-settings>
VITE_DAY1_DYNAMIC_ENABLED=true
VITE_DYNAMIC_ENVIRONMENT_ID=<dynamic-environment-id>
```

Required Dynamic dashboard settings for local Day1:

- Dynamic project/environment id in `VITE_DYNAMIC_ENVIRONMENT_ID` must match the selected project.
- Allowed origins/CORS must include:
  - `http://localhost:5173`
  - `http://127.0.0.1:5173`
- Allowed redirect/domain entries should include the same localhost hosts used above.
- JWT issuer/audience/JWKS values copied to Day1 server env must match Dynamic JWT settings exactly.

If these values are missing/mismatched, the frontend degrades Dynamic to a
non-blocking mode and keeps guest bootstrap + local gameplay paths active.

Flow:

1. User authenticates in frontend Dynamic widget.
2. Frontend calls `POST /api/auth/dynamic/login` with Dynamic auth token.
3. Server verifies JWT signature/issuer/audience against Dynamic JWKS.
4. Server links provider identity to existing local account (or creates one),
   then issues the same Day1 cookie + CSRF session payload used by existing auth
   endpoints.

Guest fallback:

1. Frontend calls `POST /api/auth/guest` when user selects `Continue as Guest`.
2. Server creates a local guest identity and issues Day1 cookie + CSRF session.

This keeps a no-lock-in path: local account/session records remain usable even
if Dynamic is disabled, and legacy `register`/`login` routes remain available
for compatibility/testing.

### Wallet Backup Export (Client-Side)

Day1 includes a minimal `Export Wallet Backup` action in the account panel.

- The export runs fully in the browser and downloads a JSON file locally.
- No backup payload is sent to Day1 server endpoints.
- The exported artifact is versioned (`schema = "ergo-account-export"`, `schemaVersion = 1`) and includes:
  - account session identity + migration metadata from `@twobitedd/ergo-account-model`,
  - additive account state/conversion snapshot notes used by Day1 account panel and export flow,
  - current wallet binding summary (`ergoAddress`, `walletStatus`),
  - encrypted vault payload when detected in browser localStorage (`ergo-dynamic-vault-v1`) or Dynamic metadata (`ergoVaultV1`).

If no encrypted vault payload exists, the file still exports migration/portability metadata so users can preserve account state and move away from Dynamic later.

## Schema and Migrations

- Day 1 uses SQLite with idempotent schema bootstrapping in `server/store.ts` (`CREATE TABLE IF NOT EXISTS`).
- `npm run db:init` is the migration-safe entrypoint and can be rerun on every startup.
- Current schema covers accounts, sessions, wallet bindings, games, game events, leaderboard stats, reward snapshots, on-chain intent stubs, and auth rate-limit state.
- `games.game_type` is additive and defaults to `tic_tac_toe` for backward compatibility.
- Distributed safety schema includes idempotency key ledgering and endpoint telemetry counters.
- Ratification schema includes schedule/checkpoint tables and ratification batch lifecycle records.
- Migration policy for this MVP:
  - additive columns/tables only (no destructive drops),
  - preserve no-wager behavior and deterministic gameplay constraints,
  - test DB changes via `npm run test` before local rollout.

## Commands (Exact)

```bash
npm run db:init
npm run lint
npm run build
npm run test
npm run check
npm run dev
```

`npm run check` runs lint + build + tests.

## Railway Deployment (Day1)

Day1 now includes `railway.json` and `Procfile` so Railway can run it as a
single web service:

_Deploy note: keeping this section current triggers Railway source redeploys when needed._
_Build trigger note: commit `bcaa1b7` fixed npm package resolution for Railway._
_Build trigger note: commit `92f43b0` updates Day1 to consume published `@twobitedd/ergo-account-model@^0.2.0`._

1. `npm install`
2. `npm run build` (creates frontend `dist/` bundle)
3. `npm run start` (starts API and serves `dist/` when present)

Recommended Railway service variables:

```bash
NODE_ENV=production
DAY1_API_PORT=$PORT
DAY1_CORS_ALLOWED_ORIGINS=https://<your-railway-domain>
DAY1_TOTP_ENCRYPTION_KEY=<strong-random-value>
DAY1_CHAIN_NETWORK=testnet
DAY1_ERGO_NODE_URL=https://api-testnet.ergoplatform.com
```

If frontend and API are split across different domains, set
`DAY1_CORS_ALLOWED_ORIGINS` to a comma-separated list of allowed origins.

Readiness checks:

- Liveness: `GET /api/health`
- Readiness: `GET /api/health/readiness`

## Security Notes (MVP Scope)

- Passwords are never stored in plaintext.
- Session auth uses HTTP-only cookie + server-side session records in SQLite.
- Cookie-authenticated mutations enforce CSRF checks via `x-day1-csrf-token`.
- Auth rate-limit state is persisted in SQLite for basic brute-force resistance.
- Critical write endpoints support `idempotency-key` replay semantics to reduce duplicate mutation risk in retries/multi-instance ingress.
- Register/login throttles are keyed by IP and IP+identifier variants for better abuse containment.
- Recovery tokens are hashed-at-rest, expire quickly, and are one-time use.
- TOTP enrollment and trusted-device controls exist as practical foundations.
- Security events and metric counters are captured in SQLite as structured records.
- Request logs emit JSON with request/correlation ids for distributed trace stitching.
- Wallet linkage remains optional and separate from account authentication.
- This is still MVP hardening, not full production-grade security.

## Still Not Full Production

- MFA/recovery/device controls are foundational; email delivery, backup codes, and policy tuning are still pending
- Redis-backed distributed limiter execution is scaffolded but still falls back to sqlite (no live redis algorithm parity yet)
- No external SIEM/alerting integration yet (local SQLite audit/metrics only)
- No native in-process Ergo signing library is bundled here; real mode assumes an external signer handoff and signed tx return path.
- Explorer/node response fields vary by deployment; adapter parsing is resilient but should be validated against your exact endpoint versions.

## Real Mode Smoke Commands

```bash
# 1) start API in real mode (external signer handoff)
DAY1_CHAIN_MODE=ergo \
DAY1_CHAIN_NETWORK=mainnet \
DAY1_SERVER_WALLET_ADDRESS=9... \
DAY1_SERVER_WALLET_SECRET=replace_me \
DAY1_ERGO_NODE_URL=https://your-mainnet-node.example.com:9053 \
DAY1_ERGO_EXPLORER_URL=https://api.ergoplatform.com \
DAY1_ERGO_SIGNING_MODE=external \
npm run dev:server

# 2) run frontend
npm run dev:client

# 3) check readiness and adapter mode
curl -s http://localhost:4010/api/health/readiness
```

For a complete copy-paste Day1 mainnet local workflow, see `docs/mainnet-day1-local-testing.md`.

## Deployment Topology Notes (Distributed Caveats)

- Day1 remains local-first by design; multi-instance behavior assumes shared persistence visibility.
- Session revocation/password-reset flows are persisted and validated server-side each request, so stale tokens drop as soon as a node reads updated session state.
- Idempotency safeguards are persisted, enabling safe replay for critical writes when upstream retries occur.
- For production parity, replace scaffolded redis limiter + simulated ratifier adapter with fully externalized services and dedicated operational alerting.

## Notes

- This project intentionally keeps no-wager language and no payout behavior.

## Add A New Game Module

1. Add a new `GameType` entry in `@twobitedd/ergo-games-interface` platform contracts.
2. Implement a `GameEngine` adapter in `server/runtime/engines/`.
3. Register the engine in `server/runtime/registry.ts` with metadata.
4. Reuse `StoreBackedGameSessionService` or extend it only if new persistence behavior is required.
5. Keep move semantics backward compatible: existing `tic_tac_toe` routes still work through runtime dispatch.
6. Add route-level coverage in `server/app.test.ts` for registry listing, create flow, and move behavior.
