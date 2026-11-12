"""Schemas at the AI boundary. Every model answer is validated against one of these;
anything that does not validate is treated as unreadable (fail closed)."""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation

from pydantic import BaseModel, ConfigDict, Field, field_validator

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class InvoiceFields(BaseModel):
    """What the extractor must produce. Strict: unknown keys are rejected."""

    model_config = ConfigDict(extra="forbid")

    vendor_name: str = Field(min_length=1, max_length=200)
    invoice_number: str = Field(min_length=1, max_length=80)
    amount: str = Field(description="Total due as a decimal string, e.g. '1250.00'")
    currency: str = Field(min_length=3, max_length=3)
    due_date: date | None = None
    payout_email: str
    # What the model itself noticed: text that tries to instruct the reader.
    suspicious_instructions: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("vendor_name", "invoice_number")
    @classmethod
    def strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v

    @field_validator("amount")
    @classmethod
    def decimal_amount(cls, v: str) -> str:
        cleaned = v.replace(",", "").replace("$", "").strip()
        try:
            d = Decimal(cleaned)
        except InvalidOperation as e:
            raise ValueError(f"not a decimal amount: {v!r}") from e
        if d <= 0 or d.as_tuple().exponent < -2:
            raise ValueError(f"amount must be positive with at most 2 decimals: {v!r}")
        return f"{d:.2f}"

    @field_validator("currency")
    @classmethod
    def upper_currency(cls, v: str) -> str:
        v = v.strip().upper()
        if not v.isalpha():
            raise ValueError("currency must be a 3-letter code")
        return v

    @field_validator("payout_email")
    @classmethod
    def email(cls, v: str) -> str:
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError(f"not an email: {v!r}")
        return v


class Flag(BaseModel):
    code: str
    detail: str = ""


class ReviewText(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=1200)
    recommendation: str = Field(pattern=r"^(approve|deny|investigate)$")


# --- Request and response bodies --------------------------------------------------------


class ReadInvoiceRequest(BaseModel):
    text: str | None = None
    pdf_base64: str | None = None
    filename: str | None = None
    # Send the proposal to the Rust core (default). False = extraction only.
    propose: bool = True


class ReadInvoiceResponse(BaseModel):
    status: str  # "proposed" | "extracted" | "unreadable"
    source_hash: str
    fields: InvoiceFields | None
    flags: list[Flag]
    extractor: str  # "live:<model>" | "replay" | "offline"
    decision: dict | None = None
    error: str | None = None


class ReviewRequest(BaseModel):
    vendor_name: str
    invoice_number: str
    amount: str
    currency: str = "USD"
    decision: str
    reasons: list[dict] = Field(default_factory=list)
    agent_flags: list[dict] = Field(default_factory=list)


class ReviewResponse(BaseModel):
    summary: str
    recommendation: str
    reviewer: str


# --- Milestone checks ---------------------------------------------------------------------


class CriterionCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    criterion: str = Field(min_length=1)
    passed: bool
    # A short quote from the evidence that supports the verdict, or why it is missing.
    reason: str = Field(max_length=400)
    confidence: float = Field(ge=0.0, le=1.0)


class MilestoneCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[CriterionCheck] = Field(max_length=30)
    suspicious_instructions: list[str] = Field(default_factory=list, max_length=10)


class CheckMilestoneRequest(BaseModel):
    milestone_id: str | None = None
    criteria: list[str] = Field(min_length=1, max_length=30)
    evidence: str = Field(min_length=1, max_length=40_000)
    evidence_hash: str | None = None
    # Send the result to the Rust core (needs milestone_id and evidence_hash).
    submit: bool = True


class CheckMilestoneResponse(BaseModel):
    results: list[CriterionCheck]
    flags: list[Flag]
    checker: str
    all_passed: bool
    core: dict | None = None
    error: str | None = None


class PayPalReadRequest(BaseModel):
    tool: str
    arguments: dict = Field(default_factory=dict)
