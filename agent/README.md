# Cosign agent (Python)

Reads invoices and proposes payments to the Rust core. It holds no PayPal secret and has no
tool that moves money; its core token can only submit proposals.

## Run

```bash
pip install -e ".[dev]"
export CORE_URL=http://localhost:8080 CORE_AGENT_TOKEN=local-agent-token-change-me
uvicorn cosign_agent.app:app --port 8000
curl -s localhost:8000/agent/read-invoice -H 'content-type: application/json' \
  -d '{"text": "From: Northwind Design Studio\nInvoice No: NW-1\nDue date: 2026-11-30\nTotal due: USD 10.00\nPay to (PayPal): billing@northwind.example"}'
```

| Endpoint | Purpose |
|---|---|
| `POST /agent/read-invoice` | `{text}` or `{pdf_base64}`; `propose: false` for extraction only. Returns fields, flags, source hash and the core's decision. |
| `POST /agent/review` | A plain-English second opinion for an approval card. Advisory text only. |
| `POST /agent/check-milestone` | `{milestone_id, evidence_hash, criteria, evidence}`: a verdict per criterion with a quote and confidence, sent to the core. `submit: false` to only check. |
| `GET /agent/paypal/tools`, `POST /agent/paypal/read` | Read-only PayPal through PayPal's MCP server (`pip install ".[mcp]"`, Node.js, and `COSIGN_SHARE_READ_TOKEN=1` on the core). Write tools are refused before the server starts. |
| `GET /healthz` | Mode, and `holds_paypal_secret: false` |

Set `AGENT_API_TOKEN` to require a bearer token from callers.

## Model modes (`COSIGN_LLM_MODE`)

| Mode | Behaviour |
|---|---|
| `replay` (default) | Saved answer for this exact task and input if one is in `replay/`, else the deterministic reader. No key, no spend. |
| `live` | Calls the model (`COSIGN_LLM_PROVIDER=anthropic\|openai`, `COSIGN_LLM_MODEL`, default `claude-haiku-5-5`), validates, saves to `replay/`. Capped by `COSIGN_LLM_DAILY_CALLS` (default 200). |
| `offline` | Deterministic reader only (CI, evals). |

Rules at the boundary: every answer is validated against a strict pydantic schema
(`models.py`); anything that does not validate is UNREADABLE and never reaches the core as a
payment. The document goes to the model inside `<document>` tags with no tools. The injection
scan (`injection.py`) runs on the raw text first; its flags can only escalate.

## Evals

```bash
python -m evals.run                                   # extraction + injection flags
python -m evals.run --core http://localhost:8080      # end to end; needs a fresh, seeded core
```

Results: see the root README and `evals/results.md`. The corpus has 20 invoices (11 attacks, 5 normal, 4 borderline) and 20 deliverable checks (7 good, 5 partial, 4 bad, 4 attacks).

Read the numbers as a regression check, not accuracy. The deterministic readers and the corpus were written together, and the deliverable checker was improved after its first run (16 of 20 right) using those same cases: numbers in criteria became binding, comparator words stopped counting as evidence, and evidence that admits nothing was delivered now fails every criterion. Credible numbers need cases written by someone else and a live-model run.
