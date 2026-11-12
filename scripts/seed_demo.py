"""Seeds the core with the demo mandate and fictional vendors, so every demo scene starts
from the same state. Standard library only.

    CORE_URL=http://localhost:8080 CORE_OPERATOR_TOKEN=... python scripts/seed_demo.py

Safe to rerun: existing vendors are kept, and a new mandate version is recorded."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

CORE = os.environ.get("CORE_URL", "http://localhost:8080").rstrip("/")
TOKEN = os.environ.get("CORE_OPERATOR_TOKEN", "")

MANDATE = {
    "owner_id": os.environ.get("COSIGN_OWNER", "demo"),
    "rules": {
        "currency": "USD",
        "per_invoice_cap_cents": 200_000,  # $2,000 per invoice
        "daily_cap_cents": 500_000,  # $5,000 per day
        "velocity_max_payments": 5,
        "velocity_window_minutes": 60,
        "due_date_max_past_days": 60,
        "due_date_max_future_days": 120,
    },
    # Long enough to cover judging (Dec 1 to Dec 15).
    "expires_at": (datetime.now(timezone.utc) + timedelta(days=int(os.environ.get("MANDATE_DAYS", "90")))).replace(microsecond=0).isoformat(),
}

VENDORS = [
    {"name": "Northwind Design Studio", "paypal_email": "billing@northwind.example"},
    {"name": "Contoso Legal LLP", "paypal_email": "accounts@contoso.example"},
    {"name": "Adatum Cloud Hosting", "paypal_email": "ops-billing@adatum.example"},
]


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(
        CORE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def wait_for_core(seconds: int = 60) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(CORE + "/healthz", timeout=3) as r:
                if r.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    sys.exit(f"core at {CORE} did not become healthy")


def main() -> int:
    if not TOKEN:
        sys.exit("set CORE_OPERATOR_TOKEN")
    wait_for_core()
    status, m = call("POST", "/v1/mandates", MANDATE)
    if status != 201:
        sys.exit(f"mandate failed: {status} {m}")
    print(f"mandate {m['id']} hash {m['hash'][:12]}... expires {m['expires_at']}")
    for v in VENDORS:
        status, body = call("POST", "/v1/vendors", v)
        if status == 201:
            print(f"vendor  {v['name']} <{v['paypal_email']}>")
        elif status == 409:
            print(f"vendor  {v['name']} (already exists)")
        else:
            sys.exit(f"vendor failed: {status} {body}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
