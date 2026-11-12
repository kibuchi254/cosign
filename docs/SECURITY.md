# Security model

The design rule: **the AI proposes, Rust decides, and only Rust can pay.**

| Threat | Control | Where |
|---|---|---|
| Prompt injection in an invoice | Text is data inside `<document>` tags; deterministic scan + model-noticed text become flags; flags can only add reasons | `agent/cosign_agent/injection.py`, `core/src/policy.rs` |
| The agent is tricked into paying | No money tools; its token can only call `POST /v1/proposals`; the executor needs `Authorized<T>`, which only the policy module can build | `core/src/api.rs`, `core/src/executor.rs` |
| The agent approves its own proposal | Approvals need the operator token (tested) | `core/tests/api.rs` |
| PayPal credentials leak | Secret only in the core's environment; compose and Render give the agent no `PAYPAL_*` | `deploy/` |
| Forged webhook | Every event is checked with PayPal's verify endpoint using the raw body; unsigned requests are rejected; simulation mode refuses all webhooks | `core/src/service.rs` |
| Duplicate webhook | `webhook_events.event_id` primary key | migration |
| A retry pays twice | `PayPal-Request-Id` and `sender_batch_id` = the payment's idempotency key; an unknown outcome stays `SUBMITTED`, never auto-retried as new | `core/src/executor.rs` |
| Approval bypass or stale approval | One code path to PayPal; an approval must quote the decision hash; BLOCK cannot be approved; one verdict per decision | `core/src/policy.rs`, migration |
| Race past the daily cap | One decision at a time per owner (advisory lock); tested with 12 concurrent proposals | `core/src/service.rs` |
| Audit log edited | Hash chain + `GET /v1/audit/verify`; a trigger blocks UPDATE/DELETE | `core/src/audit.rs`, migration |
| Fooled milestone check releases money | The agent can verify or hold; only the operator token can release, and `authorize_release` refuses anything not Verified, or held and not accepted by the buyer | `core/src/policy.rs`, `core/src/milestones.rs` |
| Swapped or stale delivery evidence | Criteria results must quote the hash of the evidence the core holds | `core/src/milestones.rs` |
| Release paid twice | Capture and payout reuse the milestone's release key as `PayPal-Request-Id`; the row stays locked during the call | `core/src/milestones.rs` |
| Browser sees a token | The web app calls the core and agent only from server components and server actions; the console sits behind a signed, HTTP-only session cookie (`proxy.ts`) | `lib/cosign.ts`, `lib/session.ts` |
| Lookalike vendor | Exact match uses light normalization only; homoglyph folding is used only to *detect* lookalikes, never to accept one | `core/src/similarity.rs` |

## Known limits

- **The chain shows edits; it cannot stop someone who controls the database from rebuilding
  it.** An attacker with database superuser rights can rewrite every hash after the edit.
  Publishing the head hash somewhere outside the database (the README, a commit, a webhook)
  would close this.
- `Authorized<T>` is enforced by Rust's privacy rules: nothing outside `policy.rs` can build
  one. Code inside the crate could still fake the database rows the approval path reads,
  so the guarantee covers the code paths, not a hostile insider.
- The read-only MCP path needs a PayPal access token. The core mints it and shares only the
  token, never the secret, but PayPal tokens are not scoped down, so a leaked token can do
  whatever the REST app can. That is why sharing is off unless `COSIGN_SHARE_READ_TOKEN=1`.
- The sponsor's PayPal data pages (`/paypal`, `/dashboard`) read PayPal with the client secret
  in the web app's environment. They are for local development; the deployed web app gets no
  PayPal credentials.
- Tokens are static bearer tokens. Fine for the demo; a real launch needs user auth for approvers.
