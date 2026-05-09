# Day1 Mainnet Local Testing

This runbook configures Day1 to use Ergo mainnet defaults for local testing.
It keeps secrets as placeholders so you can supply your own values safely.

## Required Environment Keys

Create or update `ergo-games-day1/.env.local` (or export in your shell):

```bash
DAY1_CHAIN_MODE=ergo
DAY1_CHAIN_NETWORK=mainnet
DAY1_ERGO_SIGNING_MODE=external
DAY1_SERVER_WALLET_ADDRESS=<REQUIRED_MAINNET_ERGO_ADDRESS>
DAY1_SERVER_WALLET_SECRET=<REQUIRED_SERVER_SIGNER_SECRET>
DAY1_ERGO_NODE_URL=<REQUIRED_MAINNET_NODE_URL>
DAY1_ERGO_EXPLORER_URL=https://api.ergoplatform.com
```

Also required for full local auth/security flow:

```bash
DAY1_TOTP_ENCRYPTION_KEY=<REQUIRED_HEX_64>
```

## One-Time Setup

From `ergo-games-day1`:

```bash
npm install
npm run db:init
```

## Start Day1 Locally (Mainnet Config)

```bash
npm run dev
```

- API: `http://localhost:4010`
- Frontend: `http://localhost:5173`

## Health and Readiness Checks

```bash
curl -s http://localhost:4010/api/health | jq
curl -s http://localhost:4010/api/health/readiness | jq
curl -s http://localhost:4010/api/health/env | jq
```

Expected readiness indicators:
- `serverWallet.mode` is `ergo`
- `serverWallet.network` is `mainnet`
- readiness includes wallet ready and `DAY1_ERGO_NODE_URL` configured

## Build and Test Validation

From `ergo-games-day1`:

```bash
npm run lint
npm run build
npm run test
```

## What You Can Validate Without Live Signing

- Register/login/session/csrf/device/mfa flows
- Lobby/create/join/move/rewards/leaderboard flows
- Ratification schedule visibility and adapter mode
- Ergo run prechecks and `awaiting_signature` flow in external signer mode

Signer mode notes:

- `external`: manual submit via `/api/ratification/batches/:batchId/submit-signed`
- `public-sponsor`: same payload handoff, but intended for sponsor-operated signer services
- `direct`: no manual signed submit step (server signs/submits directly)

## What Requires User Wallet/Credentials

- Real signed transaction generation for ratification batch submission
- Broadcast to mainnet node via `DAY1_ERGO_NODE_URL`
- Confirmation/finality observations against your chosen node/explorer

## Signed Submission Step (Manual)

When a batch returns `awaiting_signature`, submit signed bytes:

```bash
curl -s -X POST "http://localhost:4010/api/ratification/batches/<BATCH_ID>/submit-signed" \
  -H "content-type: application/json" \
  -H "x-day1-session-token: <SESSION_TOKEN>" \
  -H "x-day1-csrf-token: <CSRF_TOKEN>" \
  -d '{"signedTxHex":"<SIGNED_TX_HEX>"}' | jq
```
