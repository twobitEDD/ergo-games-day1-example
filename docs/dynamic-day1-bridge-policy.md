# Dynamic -> Day1 Bridge Policy (Day1 Standard)

This project uses a conservative bridge policy so reconnect storms do not spam Dynamic or churn Day1 sessions.

## Trigger Conditions

- Auto-bridge only runs when Dynamic is ready and identity is known.
- Auto-bridge is skipped when a matching Day1 session is already healthy.
- Manual bridge can still be triggered by user action.

## Retry + Backoff Limits

- Auth-token readiness: short bounded polling (`maxRetries=4`).
- Bridge API retries: only on transient/network/session-readiness failures.
- Hard failures (invalid token, identity conflict, misconfiguration, bad request) are **not retried**.
- Auto-bridge attempts are capped per identity and use exponential cooldown.
- Auto-bridge attempts are debounced with a minimum gap between attempts.

## Safe Failure Behavior

- Hard failures block further automatic retries for the same identity until identity changes.
- Auto mode surfaces guidance and waits for explicit user action.
- Server bridge endpoints reuse existing fresh sessions for same identity instead of minting new session IDs/tokens.
- Repeated same-identity bridge calls remain idempotent and do not create unnecessary sessions.
