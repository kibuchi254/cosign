# Cosign core (Rust)

The only process that decides, records and moves money. It holds the PayPal client secret;
the Python agent never does.

## Run

```bash
# Postgres must be running. Without PAYPAL_* the core simulates payouts and refuses webhooks.
export DATABASE_URL=postgres://cosign:cosign@localhost:5432/cosign
export CORE_AGENT_TOKEN=local-agent-token-change-me        # given to the Python agent
export CORE_OPERATOR_TOKEN=local-operator-token-change-me  # given to the web app
cargo run --bin cosign-core                                 # listens on $PORT (default 8080)
python ../scripts/seed_demo.py                              # mandate + fictional vendors
```

Migrations run on start. Settings: `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_WEBHOOK_ID`,
`PAYPAL_BASE_URL` (default: sandbox), `COSIGN_OWNER` (default `demo`).

## The Oct 18 gate

```powershell
$env:PAYPAL_CLIENT_ID="..."; $env:PAYPAL_SECRET="..."; $env:SPIKE_RECEIVER="<sandbox personal account email>"
cargo run --bin cosign-spike
```

It checks the OAuth token, one $1 payout (and that replaying its batch ID is refused),
authorize then capture on an order you approve as the sandbox buyer, and that the webhook
verification endpoint answers. `GATE: PASS` means the executor stays in Rust. Payouts must
be enabled on the sandbox business account.

## Tests

```bash
cargo test                                                     # unit + property tests
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres cargo test   # + API tests on real Postgres
```

| Area | What is tested |
|---|---|
| Rules (`policy.rs`) | A case table per rule, duplicates, most-severe-wins |
| Invariants (proptest) | Unknown vendor is never ALLOW · agent flags never lower severity · auto-allowed payments never pass the daily cap · tampered audit entries always fail verification |
| State machines (`state.rs`) | Every event from every state, payment and milestone |
| PayPal client (`tests/paypal_client.rs`) | Token cache, one retry on 401, 5xx backoff, no retry on 4xx, `PayPal-Request-Id`, raw webhook body forwarding (against a local fake) |
| API (`tests/api.rs`) | The three demo scenes, token roles, bad input, 12 concurrent proposals vs the daily cap, audit tampering, webhook dedupe |
| Escrow (`tests/milestones.rs`) | Stage order, stale evidence refused, agent verifies but cannot release, held work, reject and redeliver, void, the day-3 job, unknown-outcome retry |
| Contract (`tests/openapi.rs`) | Every served route is in `openapi.json` and the reverse |

## API

All bodies are JSON. `agent` = `CORE_AGENT_TOKEN`, `operator` = `CORE_OPERATOR_TOKEN`.

| Endpoint | Token | Purpose |
|---|---|---|
| `POST /v1/proposals` | agent, operator | Submit an invoice payment with extracted fields and agent flags. Returns the decision; an ALLOW is paid at once. |
| `POST /v1/approvals/{payment_id}` | operator | `{verdict: approve\|deny, approver, decision_hash, note?}`. Must quote the decision hash. BLOCK cannot be approved. |
| `GET /v1/ledger` | operator | Payments, reasons, totals, mandate and audit status for the dashboard |
| `POST /v1/mandates`, `GET /v1/mandates/active` | operator (GET: both) | Mandate versions; the newest is active |
| `GET/POST /v1/vendors` | operator | Approved vendors and their payout emails |
| `PATCH /v1/vendors/{id}` | operator | Rename, change payout email (needs `changed_by` and a verification `reason`), deactivate or reactivate; audited |
| `GET /v1/audit` | operator | Recent audit entries |
| `GET /v1/audit/verify` | none | Recompute the hash chain |
| `POST /v1/payments/{id}/retry` | operator | Re-send a SUBMITTED payment whose outcome is unknown, with its original idempotency key |
| `GET/POST /v1/deals`, `GET /v1/deals/{id}` | operator (GET one: both) | Deals with ordered milestones and acceptance criteria |
| `POST /v1/milestones/{id}/fund` and `/fund/confirm` | operator | AUTHORIZE order; live mode returns the buyer's approve link, confirm places the hold |
| `POST /v1/milestones/{id}/deliver` | operator | Seller's evidence; returns its hash |
| `POST /v1/milestones/{id}/criteria-result` | agent, operator | The agent's check. All pass: Verified. Anything else: held for the buyer |
| `POST /v1/milestones/{id}/accept`, `/reject` | operator | Buyer overrides a hold, or sends the work back |
| `POST /v1/milestones/{id}/release` | operator | Capture, then pay the seller. Verified only |
| `POST /v1/milestones/{id}/void` | operator | Cancel the hold |
| `POST /internal/reauthorize` | internal, operator | Day-3 job: reauthorize once past the honor period, expire lapsed holds |
| `GET /v1/agent/paypal-token` | agent | Access token for the read-only MCP server; off unless `COSIGN_SHARE_READ_TOKEN=1` |
| `GET /openapi.json` | none | This API as OpenAPI 3.1; a test fails if a route is missing from it |
| `POST /webhooks/paypal` | PayPal signature | Verified with PayPal, deduplicated by event ID |
| `GET /healthz` | none | DB status and live/simulated mode |

Proposal body:

```json
{
  "invoice": {
    "vendor_name": "Northwind Design Studio", "invoice_number": "NW-1042",
    "amount": "850.00", "currency": "USD", "due_date": "2026-10-31",
    "payout_email": "billing@northwind.example", "source_hash": "sha256:...", "extracted": {}
  },
  "flags": [{ "code": "INJECTION_SUSPECTED", "detail": "..." }]
}
```

## Rules

| Code | Effect |
|---|---|
| `PAYOUT_DETAILS_CHANGED`, `MANDATE_EXPIRED`, `DUPLICATE_INVOICE` | Block |
| `VENDOR_UNKNOWN` (incl. lookalike names), `OVER_INVOICE_CAP` (incl. currency not in mandate), `OVER_DAILY_CAP`, `VELOCITY`, `DUE_DATE_IMPLAUSIBLE` (incl. missing) | Require approval |
| Agent flags: `INJECTION_SUSPECTED`, `CRITERIA_FAILED`, `UNREADABLE_DOCUMENT`, any other code → `AI_FLAGGED` | Require approval at least |

Two codes are additions to the blueprint's ten: `UNREADABLE_DOCUMENT` and `AI_FLAGGED`, so an
agent flag the core does not recognise still escalates instead of being dropped.

## Settings

`CORE_INTERNAL_TOKEN` (optional, 16+ characters) lets a scheduler call `/internal/*` without the operator token. `COSIGN_SHARE_READ_TOKEN=1` enables the agent's read token. Milestone holds use PayPal's rules as the core understands them: a 3-day honor period, one reauthorization, 29 days in total; confirm these on the sandbox.
