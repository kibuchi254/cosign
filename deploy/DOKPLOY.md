# Deploying Cosign on Dokploy

Cosign runs as one Docker Compose stack: Postgres, the Rust core, the Python agent, the
Next.js web app, and a small job runner. Use `deploy/docker-compose.dokploy.yml`, not the local
`deploy/docker-compose.yml` (that one publishes every port and has public default passwords).

## 1. Create the service

1. In Dokploy: **Create Service → Compose**, provider **GitHub**, this repository, branch `main`.
2. **Compose Path:** `./deploy/docker-compose.dokploy.yml`
3. Enable **Autodeploy** if you want every push to `main` to redeploy.

The first build takes a while (the Rust core compiles in release mode, and the agent image
includes the OCR engine). Give the server at least 2 GB of RAM, or add swap, for the Rust build.

## 2. Environment (Environment tab)

A ready-to-paste set for this deployment, with fresh secrets, can be kept in `deploy/.env.dokploy`
(git-ignored, never committed). Otherwise, generate each secret with `openssl rand -hex 24` (hex only: the Postgres password goes into a URL).
All three tokens must be different.

| Variable | Required | What it is |
|---|---|---|
| `COSIGN_PUBLIC_URL` | yes | The one public domain, e.g. `https://cosign.digikenya.co.ke` (PayPal return links, OpenRouter attribution) |
| `POSTGRES_PASSWORD` | yes | Database password |
| `CORE_AGENT_TOKEN` | yes | Agent → core (propose only) |
| `CORE_OPERATOR_TOKEN` | yes | Web → core (approvals, vendors, mandate) |
| `CORE_INTERNAL_TOKEN` | yes | Scheduled job → core |
| `DEMO_PASSWORD` | yes | Password for signing in to the console |
| `SESSION_SECRET` | yes | Signs the login cookie (16+ characters) |
| `OPENROUTER_API_KEY` | for live reading | Lets the agent read invoices with GLM-5.2. Without it, set `COSIGN_LLM_MODE=offline` (deterministic reader) |
| `COSIGN_LLM_MODE` | no | `live` (default), `offline` or `replay` |
| `COSIGN_LLM_MODEL` | no | Default `z-ai/glm-5.2` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_WEBHOOK_ID` | for real payouts | Blank = payouts are simulated. Sandbox by default |
| `COMPOSE_PROFILES` | no | Set to `demo` once to load the demo mandate and three fictional vendors |

With `COSIGN_LLM_MODE=live` and no working key, invoices come back unreadable and are never
paid (it fails closed). Set `COSIGN_LLM_FALLBACK=offline` to fall back to the deterministic reader.

## 3. One domain (Domains tab)

Add a single domain on the **`web`** service, port **3000**, with HTTPS on. That is the link you
share. Everything goes through it:

- The console: `https://<your domain>` (sign in with `DEMO_PASSWORD`).
- PayPal webhooks, if you use PayPal: point the webhook at `https://<your domain>/webhooks/paypal`.
  The web app forwards it unchanged to the core, which checks PayPal's signature. Webhooks are
  optional: the core also polls PayPal for payout results every 20 seconds.

Do not add domains for `core`, `agent` or `db`: they stay on the private network.

## 4. After the first deploy

1. Open the web domain, sign in with `DEMO_PASSWORD`.
2. Sign a mandate (**Mandate**) and approve your vendors (**Vendors**), or deploy once with
   `COMPOSE_PROFILES=demo` to load the demo data, then remove it.
3. Add an invoice: paste text, upload a PDF, or upload a photo (read with local OCR).

Data lives in the `pgdata` volume. Back it up from Dokploy (**Volume Backups**) or with
`pg_dump`.
