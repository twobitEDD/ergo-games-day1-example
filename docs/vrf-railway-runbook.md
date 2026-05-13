# Day1 + VRF Railway Runbook

This runbook documents the current development setup for Day1 VRF integration in Railway.

## Service Topology (2bitENT / development)

- VRF coordinator: `ergo-vrf-oracle`
  - URL: `https://ergo-vrf-oracle-development.up.railway.app`
- VRF operators:
  - `ergo-vrf-operator-a`
  - `ergo-vrf-operator-b`
  - `ergo-vrf-operator-c`
- Day1 VRF test service:
  - `ergo-games-day1-vrf-test`
  - URL: `https://ergo-games-day1-vrf-test-development.up.railway.app`

## Required Environment Variables

### VRF coordinator (`ergo-vrf-oracle`)

```bash
VRF_SERVICE_MODE=coordinator
HOST=0.0.0.0
```

### VRF operators (`ergo-vrf-operator-a/b/c`)

```bash
VRF_SERVICE_MODE=operator
VRF_ORACLE_URL=https://ergo-vrf-oracle-development.up.railway.app
VRF_OPERATOR_ID=operator-a|operator-b|operator-c
VRF_OPERATOR_SECRET=<unique-per-operator-secret>
VRF_OPERATOR_REWARD_ADDRESS=9foperatora|9foperatorb|9foperatorc
VRF_OPERATOR_INTERVAL_MS=5000
```

### Day1 (`ergo-games-day1-vrf-test`)

```bash
NODE_ENV=production
DAY1_VRF_ADAPTER_MODE=http_oracle
DAY1_VRF_ORACLE_URL=https://ergo-vrf-oracle-development.up.railway.app
DAY1_VRF_MAX_SUBMISSIONS=2
```

## Deploy / Redeploy Commands

From workspace root:

```bash
railway link -p twobitENT -e development
```

From `ergo-vrf-oracle-standalone`:

```bash
railway up --service ergo-vrf-oracle --environment development --ci --path-as-root .
railway up --service ergo-vrf-operator-a --environment development --ci --path-as-root .
railway up --service ergo-vrf-operator-b --environment development --ci --path-as-root .
railway up --service ergo-vrf-operator-c --environment development --ci --path-as-root .
```

From `ergo-games-day1`:

```bash
railway up --service ergo-games-day1-vrf-test --environment development --ci --path-as-root .
```

Quick status check:

```bash
railway status
railway status --json
```

## Day1 VRF Test Procedure

1. Open `https://ergo-games-day1-vrf-test-development.up.railway.app`.
2. Register/login (guest also works for quick testing).
3. In panel `10) VRF Test Adapter`:
   - contract ref: `day1-contract:tic_tac_toe`
   - max submissions: `2`
4. Click `Request VRF`.
5. Click `Sync / Finalize` until status is `finalized`.
6. Confirm `seedHex` is present.

## API Verification (copy/paste)

```bash
BASE=https://ergo-games-day1-vrf-test-development.up.railway.app
COOKIE_JAR=$(mktemp)
EMAIL="railway-vrf-$(date +%s)@example.local"

REGISTER=$(curl -s -c "$COOKIE_JAR" -H "content-type: application/json" \
  -X POST "$BASE/api/auth/register" \
  -d "{\"displayName\":\"Railway VRF Tester\",\"email\":\"$EMAIL\",\"password\":\"vrfpass1234\"}")
CSRF=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["csrfToken"])' "$REGISTER")

REQUEST=$(curl -s -b "$COOKIE_JAR" -H "x-day1-csrf-token: $CSRF" -H "content-type: application/json" \
  -X POST "$BASE/api/vrf/test/request" \
  -d '{"contractRef":"day1-contract:tic_tac_toe","maxSubmissions":2}')
REQUEST_ID=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["request"]["requestId"])' "$REQUEST")

curl -s -b "$COOKIE_JAR" -H "x-day1-csrf-token: $CSRF" -H "content-type: application/json" \
  -X POST "$BASE/api/vrf/test/request/$REQUEST_ID/sync" -d '{}'
sleep 6
curl -s -b "$COOKIE_JAR" -H "x-day1-csrf-token: $CSRF" -H "content-type: application/json" \
  -X POST "$BASE/api/vrf/test/request/$REQUEST_ID/sync" -d '{}'
curl -s -b "$COOKIE_JAR" "$BASE/api/vrf/test/request/$REQUEST_ID/status"
```
