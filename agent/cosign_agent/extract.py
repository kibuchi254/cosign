"""Invoice reading: text (or PDF) in, validated fields and advisory flags out."""

from __future__ import annotations

import base64
import hashlib
import io
import re
from datetime import date, datetime

from .injection import scan, strip_invisible
from .llm import Completion, Unreadable, complete, offline_reader
from .models import Flag, InvoiceFields

TASK = "read_invoice: extract vendor_name, invoice_number, amount (total due), currency, due_date (YYYY-MM-DD or null), payout_email (where payment should go) and suspicious_instructions"

MAX_CHARS = 40_000


def source_hash(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def pdf_to_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return "\n".join((page.extract_text() or "") for page in reader.pages[:20])


def decode_input(text: str | None, pdf_base64: str | None) -> tuple[str, bytes]:
    """Returns (document text, original bytes for hashing)."""
    if pdf_base64:
        try:
            raw = base64.b64decode(pdf_base64, validate=True)
        except Exception as e:
            raise Unreadable(f"pdf_base64 is not valid base64: {e}") from e
        try:
            return pdf_to_text(raw), raw
        except Exception as e:
            raise Unreadable(f"could not read PDF: {e}") from e
    if text is None or not text.strip():
        raise Unreadable("no document text supplied")
    return text, text.encode("utf-8")


# --- Deterministic reader -------------------------------------------------------------------

EMAIL = r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
AMOUNT = r"(?P<cur1>USD|EUR|GBP|KES|US\$|\$|€|£)?\s*(?P<num>\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?P<cur2>USD|EUR|GBP|KES)?"
SYMBOLS = {"$": "USD", "US$": "USD", "€": "EUR", "£": "GBP"}
MONTHS = "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%d %b %Y", "%B %d %Y", "%Y-%m-%d", "%Y/%m/%d"


def _first(pattern: str, text: str, flags=re.IGNORECASE | re.MULTILINE) -> re.Match | None:
    return re.search(pattern, text, flags)


def parse_date(s: str) -> date | None:
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", s.strip().rstrip(".").strip())
    for fmt in MONTHS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


@offline_reader(TASK)
def read_invoice_offline(text: str) -> dict:
    if re.search(r"<\s*(div|p|span|td|tr|br|table|html|body)\b", text, re.IGNORECASE):
        text = re.sub(r"<[^>]+>", "\n", text)
    lines = [ln.strip() for ln in text.splitlines()]
    nonempty = [ln for ln in lines if ln]

    vendor = None
    m = _first(r"^\s*(?:from|vendor|supplier|billed\s+from|bill\s+from|company)\s*[:\-]\s*(.+?)\s*$", text)
    if m:
        vendor = m.group(1)
    else:
        for ln in nonempty:
            if not re.fullmatch(r"(tax\s+)?invoice|bill", ln, re.IGNORECASE) and not re.search(EMAIL, ln):
                vendor = ln
                break

    number = None
    m = _first(r"invoice\s*(?:no\.?|number|num|#|id)\s*[:#.]?\s*#?\s*([A-Za-z0-9][A-Za-z0-9\-/_.]*)", text)
    if m:
        number = m.group(1).rstrip(".")

    amount = currency = None
    for label in (r"(?:amount|balance|total)\s+due", r"total\s+payable", r"grand\s+total", r"(?<!sub)total"):
        m = _first(rf"{label}\b[^\n\d$€£A-Z]*{AMOUNT}", text)
        if m:
            amount = m.group("num").replace(",", "")
            cur = m.group("cur1") or m.group("cur2")
            currency = SYMBOLS.get(cur, cur) if cur else None
            break
    if currency is None:
        m = _first(r"\bcurrency\s*[:\-]\s*([A-Z]{3})\b", text)
        currency = m.group(1).upper() if m else "USD"

    due = None
    m = _first(r"(?:due\s+date|payment\s+due|due\s+by|due\s+on|pay\s+by)\s*[:\-]?\s*([^\n]+)", text)
    if m:
        due = parse_date(m.group(1))

    payout = None
    for ln in lines:
        if re.search(r"paypal|pay\s+to|remit|payment\s+(to|email|details)|send\s+payment", ln, re.IGNORECASE):
            em = re.search(EMAIL, ln)
            if em:
                payout = em.group(0)
                break
    if payout is None:
        em = re.search(EMAIL, text)
        payout = em.group(0) if em else None

    missing = [k for k, v in {"vendor_name": vendor, "invoice_number": number, "amount": amount, "payout_email": payout}.items() if not v]
    if missing:
        raise Unreadable(f"could not find {', '.join(missing)}")
    return {
        "vendor_name": vendor,
        "invoice_number": number,
        "amount": amount,
        "currency": currency,
        "due_date": due.isoformat() if due else None,
        "payout_email": payout,
        "suspicious_instructions": [],
    }


# --- Orchestration ------------------------------------------------------------------------


def read_invoice(text: str) -> tuple[InvoiceFields | None, list[Flag], str, str | None]:
    """Returns (fields or None, flags, extractor source, error)."""
    text = text[:MAX_CHARS]
    flags = scan(text)
    try:
        result: Completion = complete(TASK, InvoiceFields, strip_invisible(text))
    except Unreadable as e:
        flags.append(Flag(code="UNREADABLE", detail=str(e)))
        return None, flags, "none", str(e)
    fields: InvoiceFields = result.value  # type: ignore[assignment]
    for s in fields.suspicious_instructions:
        flags.append(Flag(code="INJECTION_SUSPECTED", detail=f'model noticed: "{s[:160]}"'))
    # Two different payment destinations in one invoice is a classic redirect.
    emails = {e.lower() for e in re.findall(EMAIL, text)}
    payment_emails = {
        em.group(0).lower()
        for ln in text.splitlines()
        if re.search(r"paypal|pay\s+to|remit|payment|send", ln, re.IGNORECASE)
        for em in re.finditer(EMAIL, ln)
    }
    if len(payment_emails) > 1:
        others = sorted(payment_emails - {fields.payout_email})
        flags.append(Flag(code="AI_FLAGGED", detail=f"document names more than one payment destination: {', '.join(others)[:200]}"))
    elif fields.payout_email not in emails:
        flags.append(Flag(code="AI_FLAGGED", detail="extracted payout email does not appear in the document"))
    return fields, flags, result.source, None
