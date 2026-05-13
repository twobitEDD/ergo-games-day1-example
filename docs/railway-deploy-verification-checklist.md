# Railway Deploy Verification Checklist (Auth/Session Reliability)

Target: `ergo-games-day1`  
Scope: prevent auth/session regressions across Dynamic JWT and compatibility fallback modes.

## 0) Shared package contract gate (must pass before smoke tests)

- [ ] `@twobitedd/ergo-games-interface` version in `package.json` is expected release (currently `^0.1.1`).
- [ ] `@twobitedd/ergo-account-model` version in `package.json` is expected release (currently `^0.4.0`).
- [ ] Deployed app contract expectations still match shared package contracts:
  - game types: `tic_tac_toe`, `coin_flip_demo`
  - runtime status shape: `{ kind: "open" | "ongoing" | "won" | "drawn" }`
  - profile wallet status values: `unbound | bound_stub`

If shared package versions change, re-run full `npm run check` and this checklist before rollout.

## 1) Required environment variables by mode

### A) Dynamic JWT verified mode (primary)

Required:

- `NODE_ENV=production`
- `DAY1_API_PORT=$PORT`
- `DAY1_DYNAMIC_AUTH_ENABLED=true`
- `DAY1_DYNAMIC_JWT_ISSUER=<dynamic-issuer>`
- `DAY1_DYNAMIC_JWT_AUDIENCE=<dynamic-audience>`
- `DAY1_DYNAMIC_JWKS_URL=<dynamic-jwks-url>`
- `DAY1_CORS_ALLOWED_ORIGINS=https://<frontend-origin>`
- `DAY1_TOTP_ENCRYPTION_KEY=<strong-random-value>`

Recommended cookie defaults for cross-origin frontend:

- `DAY1_SESSION_COOKIE_SAME_SITE=none`
- `DAY1_SESSION_COOKIE_SECURE=true`

### B) Compatibility fallback mode (JWT env absent / outage)

Expected config behavior:

- `DAY1_DYNAMIC_AUTH_ENABLED` and/or JWT verifier env is absent or invalid
- `POST /api/auth/dynamic/login` returns `503 DYNAMIC_AUTH_NOT_CONFIGURED`
- `POST /api/auth/sync` still creates a usable local session (`authMode: dynamic_compatibility`)

Required baseline env still includes:

- `NODE_ENV=production`
- `DAY1_API_PORT=$PORT`
- `DAY1_CORS_ALLOWED_ORIGINS=https://<frontend-origin>`
- `DAY1_TOTP_ENCRYPTION_KEY=<strong-random-value>`

## 2) Smoke test sequence (strict order)

Run from Day1 root against deployed Railway URL:

```bash
export DAY1_BASE_URL="https://<your-railway-service>"
```

### Step 1: health/readiness

- [ ] `GET $DAY1_BASE_URL/api/health` returns `200` and `ok: true` (or documented expected value)
- [ ] `GET $DAY1_BASE_URL/api/health/readiness` returns expected status for current chain mode/env

### Step 2: Dynamic login -> Day1 session

- [ ] Perform Dynamic widget login in UI and trigger Day1 sync (`POST /api/auth/dynamic/login`)
- [ ] Verify `GET /api/auth/session` returns `200`
- [ ] Verify response has:
  - `active: true`
  - `session.userId` non-empty
  - `profile.userId` matches session user
  - `csrfToken` present

### Step 3: game types and game lifecycle under same session

- [ ] `GET /api/game-types` returns `200` and includes both expected game types
- [ ] `POST /api/game/create` returns `201` with `game.gameType`
- [ ] `POST /api/game/:gameId/join` (second user/session) returns `200`
- [ ] `POST /api/game/:gameId/move` returns `200` for valid move

### Step 4: compatibility fallback check (required before production sign-off)

- [ ] In fallback-config environment, `POST /api/auth/dynamic/login` returns `503`
- [ ] `POST /api/auth/sync` returns `201` with `authMode: dynamic_compatibility`
- [ ] `GET /api/auth/session` after sync returns `200`
- [ ] `GET /api/game-types` and `POST /api/game/create` still succeed in fallback session

### Step 5: wallet-state and rewards behavior

- [ ] `GET /api/auth/session` shows `profile.walletStatus` (`unbound` initially)
- [ ] `POST /api/wallet/bind` succeeds and `walletStatus` becomes `bound_stub`
- [ ] `GET /api/rewards/get` still returns `200` before/after wallet bind

Note: explicit wager/capability gate endpoint is not currently implemented in Day1; treat this as **N/A** until a backend capabilities contract is introduced.

## 3) Expected API response anchors

Use these anchors to quickly detect auth/session regressions.

### `GET /api/auth/session` (expected `200`)

```json
{
  "scaffold": true,
  "active": true,
  "session": { "sessionId": "...", "userId": "..." },
  "profile": { "userId": "...", "walletStatus": "unbound|bound_stub" },
  "csrfToken": "..."
}
```

### `GET /api/game-types` (expected `200`)

```json
{
  "scaffold": true,
  "gameTypes": [
    { "gameType": "tic_tac_toe" },
    { "gameType": "coin_flip_demo" }
  ]
}
```

### `POST /api/game/create` (expected `201`)

```json
{
  "scaffold": true,
  "game": {
    "gameId": "...",
    "gameType": "tic_tac_toe|coin_flip_demo",
    "createdByUserId": "..."
  }
}
```

## 4) Release gate outcome

Deploy is **blocked** if any of the following are true:

- session cannot be established after Dynamic login
- fallback `auth/sync` path cannot establish session when Dynamic JWT verifier is unavailable
- game types/create flow fails under authenticated session
- shared package contract expectations drift from deployed API behavior
