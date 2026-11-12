"""A plain-English second opinion for the approval card. Advisory text only: the core never
reads it, and it cannot change a decision."""

from __future__ import annotations

import json

from .llm import Unreadable, complete, offline_reader
from .models import ReviewRequest, ReviewResponse, ReviewText

TASK = "review_flagged_payment: explain in 2-4 plain sentences why this payment was flagged and what the approver should check; recommendation is approve, deny or investigate"

ADVICE = {
    "PAYOUT_DETAILS_CHANGED": ("The payout email does not match the one on file for this vendor. This is the most common invoice fraud pattern.", "deny"),
    "DUPLICATE_INVOICE": ("This invoice number was already used by this vendor.", "deny"),
    "MANDATE_EXPIRED": ("The owner's spending mandate has expired, so nothing can be paid until it is renewed.", "deny"),
    "INJECTION_SUSPECTED": ("The document contains text that tries to instruct the system or rush the payment.", "investigate"),
    "VENDOR_UNKNOWN": ("The payee is not on the approved vendor list.", "investigate"),
    "OVER_INVOICE_CAP": ("The amount is above what the mandate allows per invoice.", "investigate"),
    "OVER_DAILY_CAP": ("Paying this would pass today's spending cap.", "investigate"),
    "VELOCITY": ("There have been unusually many payments in a short time.", "investigate"),
    "DUE_DATE_IMPLAUSIBLE": ("The due date is missing or far from today.", "investigate"),
    "UNREADABLE_DOCUMENT": ("The agent could not read the document reliably.", "investigate"),
    "AI_FLAGGED": ("The agent noticed something unusual in the document.", "investigate"),
    "CRITERIA_FAILED": ("A deliverable did not meet its acceptance criteria.", "investigate"),
}
RANK = {"approve": 0, "investigate": 1, "deny": 2}


@offline_reader(TASK)
def review_offline(document: str) -> dict:
    item = json.loads(document)
    codes = [r.get("code", "") for r in item.get("reasons", [])]
    sentences, rec = [], "approve"
    for code in dict.fromkeys(codes):
        text, r = ADVICE.get(code, (f"Flag {code} was raised.", "investigate"))
        sentences.append(text)
        rec = max(rec, r, key=RANK.__getitem__)
    if not sentences:
        sentences.append("No rule flagged this payment.")
    check = {
        "deny": "Do not approve unless you have confirmed the details with the vendor through a channel you already trust.",
        "investigate": "Confirm the vendor and amount independently (a phone number you already have, not one on the invoice) before approving.",
        "approve": "Nothing here needs extra checks.",
    }[rec]
    return {"summary": " ".join(sentences[:3] + [check]), "recommendation": rec}


def review(req: ReviewRequest) -> ReviewResponse:
    # Only the fields the reviewer needs; the original document is not re-sent.
    doc = json.dumps(req.model_dump(), sort_keys=True)
    try:
        c = complete(TASK, ReviewText, doc)
        v: ReviewText = c.value  # type: ignore[assignment]
        return ReviewResponse(summary=v.summary, recommendation=v.recommendation, reviewer=c.source)
    except Unreadable as e:
        return ReviewResponse(summary=f"No second opinion available ({e}). Review the reasons above directly.", recommendation="investigate", reviewer="none")
