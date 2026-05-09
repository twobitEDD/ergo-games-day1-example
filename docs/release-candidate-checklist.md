# Release Candidate Checklist

Date: 2026-05-07  
Target: `ergo-games-day1`  
Scope: full RC validation matrix (no-wager flows only)

## Environment Setup

- OS: macOS `darwin 24.6.0`
- Node/npm runtime from local workspace environment
- Project root: `/Users/se.csn/Documents/DEV/github.com/twobitedd/ergo-games/ergo-games-day1`
- Baseline commands run from project root
- Smoke servers launched on isolated ports to avoid collision with existing sessions:
  - API smoke: `DAY1_API_PORT=4022 npm run dev:server`
  - API ergo-config check: `DAY1_CHAIN_MODE=ergo DAY1_API_PORT=4023 npm run dev:server`
  - Client smoke: `npm run dev:client -- --host 127.0.0.1 --port 5188 --strictPort`

## Checklist Results (Pass/Fail + Evidence)

### 1) Lint / Build / Tests / Check

- [x] `npm run lint` passed
  - Evidence: `eslint .` exited `0`
- [x] `npm run build` passed
  - Evidence: `vite build` exited `0`, built assets under `dist/`
- [x] `npm run test` passed
  - Evidence: TAP summary `tests 19`, `pass 19`, `fail 0`
- [x] `npm run check` passed
  - Evidence: combined lint/build/test pipeline exited `0`

### 2) DB Init / Migration Lifecycle

- [x] default DB init is rerunnable/idempotent
  - Evidence: `npm run db:init && npm run db:init` both emitted `[day1-db] initialized schema`
- [x] custom DB path init is rerunnable/idempotent
  - Evidence: `DAY1_DB_PATH=/tmp/day1-rc-validate.sqlite npm run db:init` run twice; SQLite file created successfully

### 3) Server / Client Startup Smoke

- [x] API startup smoke passed
  - Evidence: `DAY1_API_PORT=4022 npm run dev:server` logged `listening on http://localhost:4022`
- [x] Client startup smoke passed
  - Evidence: `npm run dev:client -- --host 127.0.0.1 --port 5188 --strictPort` logged Vite ready and local URL
- [x] Basic runtime reachability passed
  - Evidence command (Node fetch):
    - client: `status 200`, `id="root"` present
    - `/api/health`: `status 200`, `ok true`

### 4) Auth Flows

- [x] register/login/logout/session passed
  - Evidence:
    - automated tests: `register/login/session/signout flow uses secure session semantics` passed
    - live probes on port `4022`: register/login/session success paths returned `200/201`
- [x] csrf flow passed
  - Evidence:
    - automated test: `csrf enforcement blocks cookie-auth mutations without token` passed
    - live probe: `POST /api/auth/csrf -> 200`
- [x] recovery flow passed
  - Evidence:
    - automated test: `password reset token is one-time and expires safely` passed
    - live probes: `POST /api/auth/recovery/request -> 202`, `POST /api/auth/recovery/reset -> 200`
- [x] mfa flow passed
  - Evidence:
    - automated test: `mfa totp enrollment and login guardrails work` passed
    - live probes: enrollment start/verify succeeded; login without code returned `MFA_REQUIRED`; login with TOTP succeeded
- [x] trusted-device flow passed
  - Evidence live probes:
    - `GET /api/security/devices -> 200`
    - `POST /api/security/devices/trust -> 201`
    - `POST /api/security/devices/:deviceId/revoke -> 200`
- [x] session revoke flow passed
  - Evidence live probes:
    - `GET /api/security/sessions -> 200`
    - `POST /api/security/sessions/:sessionId/revoke -> 200`

### 5) Gameplay Flows

- [x] create/join passed
  - Evidence live probes:
    - `POST /api/game/create -> 201`
    - `POST /api/game/<id>/join -> 200`
- [x] turn enforcement passed
  - Evidence live probe:
    - out-of-turn move returned `400` before valid sequence
- [x] sync passed
  - Evidence live probes:
    - both players read `GET /api/game/<id> -> 200` after move sequence
- [x] post-game reward passed
  - Evidence live probe:
    - `GET /api/rewards/get -> 200` after completed match
- [x] deterministic gameplay constraints regression check passed
  - Evidence automated test:
    - `turn ownership and leaderboard progression remain enforced`

### 6) Lobby / Players / Leaderboard / Game-Type Selection

- [x] lobby listing passed
  - Evidence:
    - automated test: `lobby listings and join from list work`
    - live probes: `GET /api/games?status=open -> 200` for both users
- [x] players endpoint passed
  - Evidence live probe: `GET /api/players/recent -> 200`
- [x] leaderboard endpoint passed
  - Evidence live probe: `GET /api/leaderboard -> 200`
- [x] game-type selection passed
  - Evidence:
    - automated test: `game registry lists adapters and allows typed game creation`
    - live probes: `GET /api/game-types -> 200`, typed create with `gameType=tic_tac_toe` returned `201`

### 7) Ratification Pipeline

- [x] simulated mode run path passed
  - Evidence live probes on `4022`:
    - `GET /api/ratification/schedule -> 200`
    - `POST /api/ratification/run -> 200`
    - `GET /api/ratification/batches?limit=5 -> 200`
- [x] ergo mode config validation path passed
  - Evidence live probes on `4023` (`DAY1_CHAIN_MODE=ergo` without required wallet/indexer config):
    - `POST /api/ratification/run -> 503`
    - error: `ERGO_MODE_CONFIGURATION_INCOMPLETE`
    - `/api/health/readiness -> 503`, adapter mode `ergo`
- [x] signed handoff API path passed (test harness)
  - Evidence focused test command:
    - `node --import tsx --test "server/ratification.test.ts" --test-name-pattern "ergo external signer flow persists awaiting signature then submits signed tx"`
    - TAP output includes: `ok - ergo external signer flow persists awaiting signature then submits signed tx`
    - also logs `POST /api/ratification/batches/<id>/submit-signed -> 200`

### 8) Health / Readiness / Telemetry Endpoints

- [x] health endpoint passed
  - Evidence: `/api/health -> 200`, payload reported `ok true` in simulated mode
- [x] readiness endpoint behavior passed (expected conditional)
  - Evidence:
    - simulated server without wallet config: `/api/health/readiness -> 503` (`ready false`)
    - ergo config check server: `/api/health/readiness -> 503` with adapter `ergo` and incomplete config
- [x] telemetry/security metrics/events endpoints passed
  - Evidence live probes:
    - `GET /api/security/events -> 200`
    - `GET /api/security/metrics -> 200`

## Blockers and Severity

### Must-Fix Before RC Go-Live

- None for simulated/local-first no-wager release candidate scope validated here.

### Must-Fix If Ergo Real-Mode Is In Scope For This RC

- Missing required ergo runtime configuration keeps readiness red and blocks ratification run (`ERGO_MODE_CONFIGURATION_INCOMPLETE`).
  - Required env family includes wallet readiness (`DAY1_SERVER_WALLET_ADDRESS`, `DAY1_SERVER_WALLET_SECRET`) and indexer/node URL config.

### Post-Release Follow-Up

- Harden and clarify recovery/session UX sequencing around password reset + signout ordering in docs/acceptance tests (observed one `SESSION_NOT_FOUND` signout when session had already been invalidated).
- Add a dedicated non-test script for end-to-end signed handoff API smoke in a staging-like ergo config to complement test-harness validation.

## Go / No-Go Recommendation

- **Recommendation: GO** for simulated-mode no-wager RC release.
- **Conditional No-Go** for ergo real-mode release unless required wallet/indexer env readiness is fully provisioned and verified in target environment.

## Follow-Up Actions

1. Decide whether this RC includes ergo real-mode; if yes, treat ergo config readiness as release-gating.
2. If ergo mode is in-scope, run a staging smoke with production-like wallet/indexer endpoints and capture `/api/health/readiness` green evidence.
3. Keep current no-wager phrasing and constraints unchanged in release notes.

