"""Client for the Rust core. The agent's token can submit proposals and read the active
mandate; the core refuses it for approvals, vendors and mandates."""

from __future__ import annotations

import os

import httpx

from .models import Flag, InvoiceFields


def normalize_url(url: str) -> str:
    """Accepts a full URL or a bare host:port (Render's private network gives host:port)."""
    url = url.strip().rstrip("/")
    return url if url.startswith(("http://", "https://")) else f"http://{url}"


class CoreError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"core returned {status}: {body[:300]}")
        self.status = status
        self.body = body


class CoreClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float = 30):
        self.base_url = normalize_url(base_url or os.environ.get("CORE_URL", "http://localhost:8080"))
        self.token = token or os.environ.get("CORE_AGENT_TOKEN", "")
        self.timeout = timeout

    def _post(self, path: str, body: dict) -> dict:
        r = httpx.post(f"{self.base_url}{path}", json=body, headers={"authorization": f"Bearer {self.token}"}, timeout=self.timeout)
        if r.status_code >= 400:
            raise CoreError(r.status_code, r.text)
        return r.json()

    def propose_invoice(self, fields: InvoiceFields, flags: list[Flag], source_hash: str, owner_id: str | None = None) -> dict:
        body = {
            "owner_id": owner_id,
            "invoice": {
                "vendor_name": fields.vendor_name,
                "invoice_number": fields.invoice_number,
                "amount": fields.amount,
                "currency": fields.currency,
                "due_date": fields.due_date.isoformat() if fields.due_date else None,
                "payout_email": fields.payout_email,
                "source_hash": source_hash,
                "extracted": fields.model_dump(mode="json"),
            },
            "flags": [f.model_dump() for f in flags],
        }
        return self._post("/v1/proposals", body)

    def submit_criteria(self, milestone_id: str, evidence_hash: str, results: list, flags: list[Flag]) -> dict:
        return self._post(
            f"/v1/milestones/{milestone_id}/criteria-result",
            {"evidence_hash": evidence_hash, "results": [r.model_dump() for r in results], "flags": [f.model_dump() for f in flags]},
        )
