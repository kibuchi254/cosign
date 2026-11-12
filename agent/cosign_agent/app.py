"""FastAPI app. Run: uvicorn cosign_agent.app:app --port 8000"""

from __future__ import annotations

import os
from pathlib import Path


def _load_local_env() -> None:
    """Reads agent/.env (git-ignored) for local runs. Variables already set win."""
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_local_env()

from fastapi import Depends, FastAPI, Header, HTTPException

from . import llm
from .core_client import CoreClient, CoreError
from .extract import decode_document, read_invoice, source_hash
from .llm import Unreadable
from . import paypal_read
from .criteria import check_milestone
from .models import (
    CheckMilestoneRequest,
    CheckMilestoneResponse,
    Flag,
    PayPalReadRequest,
    ReadInvoiceRequest,
    ReadInvoiceResponse,
    ReviewRequest,
    ReviewResponse,
)
from .review import review

app = FastAPI(title="Cosign agent", version="0.1.0", description="Reads documents and proposes. Never decides, never pays.")


def core() -> CoreClient:
    return CoreClient()


def caller(authorization: str | None = Header(default=None)) -> None:
    """Optional shared token for callers of the agent (the React app). Unset = open (dev)."""
    expected = os.environ.get("AGENT_API_TOKEN")
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="missing or wrong bearer token")


@app.get("/healthz")
def health() -> dict:
    return {"ok": True, **llm.describe(), "holds_paypal_secret": False}


@app.post("/agent/read-invoice", response_model=ReadInvoiceResponse, dependencies=[Depends(caller)])
def read_invoice_endpoint(req: ReadInvoiceRequest, client: CoreClient = Depends(core)) -> ReadInvoiceResponse:
    try:
        text, raw, via = decode_document(req.text, req.pdf_base64, req.image_base64)
    except Unreadable as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    shash = source_hash(raw)
    fields, flags, extractor, error = read_invoice(text)
    if via:
        extractor = f"{via}+{extractor}"  # e.g. "ocr+live:openrouter:z-ai/glm-5.2"
    if fields is None:
        # Fail closed: nothing reaches the core without the minimum fields, so nothing is paid.
        return ReadInvoiceResponse(status="unreadable", source_hash=shash, fields=None, flags=flags, extractor=extractor, error=error)
    if not req.propose:
        return ReadInvoiceResponse(status="extracted", source_hash=shash, fields=fields, flags=flags, extractor=extractor)
    try:
        decision = client.propose_invoice(fields, flags, shash)
    except CoreError as e:
        if e.status == 422:
            flags.append(Flag(code="UNREADABLE", detail=f"core rejected the extracted fields: {e.body[:200]}"))
            return ReadInvoiceResponse(status="unreadable", source_hash=shash, fields=fields, flags=flags, extractor=extractor, error=str(e))
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:  # network
        raise HTTPException(status_code=502, detail=f"core unreachable: {e}") from e
    return ReadInvoiceResponse(status="proposed", source_hash=shash, fields=fields, flags=flags, extractor=extractor, decision=decision)


@app.post("/agent/review", response_model=ReviewResponse, dependencies=[Depends(caller)])
def review_endpoint(req: ReviewRequest) -> ReviewResponse:
    return review(req)


@app.post("/agent/check-milestone", response_model=CheckMilestoneResponse, dependencies=[Depends(caller)])
def check_milestone_endpoint(req: CheckMilestoneRequest, client: CoreClient = Depends(core)) -> CheckMilestoneResponse:
    results, flags, checker, error = check_milestone(req)
    out = CheckMilestoneResponse(results=results, flags=flags, checker=checker, all_passed=all(r.passed for r in results) and not flags, error=error)
    if req.submit:
        if not (req.milestone_id and req.evidence_hash):
            raise HTTPException(status_code=422, detail="submit=true needs milestone_id and evidence_hash")
        try:
            out.core = client.submit_criteria(req.milestone_id, req.evidence_hash, results, flags)
        except CoreError as e:
            raise HTTPException(status_code=e.status if e.status in (404, 409, 422) else 502, detail=str(e)) from e
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"core unreachable: {e}") from e
    return out


@app.get("/agent/paypal/tools", dependencies=[Depends(caller)])
def paypal_tools() -> dict:
    return {"read_only_tools": paypal_read.allowlist()}


@app.post("/agent/paypal/read", dependencies=[Depends(caller)])
def paypal_read_endpoint(req: PayPalReadRequest) -> dict:
    try:
        return paypal_read.read(req.tool, req.arguments)
    except paypal_read.ReadError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e
