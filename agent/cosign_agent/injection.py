"""Deterministic prompt-injection and social-engineering scan.

Advisory only: findings become flags, and flags can only escalate a decision in the Rust
core. The scan runs on the raw document before any model sees it."""

from __future__ import annotations

import re
import unicodedata

from .models import Flag

# (pattern, label). Case-insensitive; whitespace in patterns matches any run of whitespace.
PHRASES: list[tuple[str, str]] = [
    (r"ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|prompts?)", "asks the reader to ignore previous instructions"),
    (r"disregard (all |any )?(the )?(previous|prior|above|your) (instructions|rules|policy|policies)", "asks the reader to disregard its rules"),
    (r"(you are|act as) (now )?(an? )?(ai|assistant|agent|payment bot|system)", "addresses an AI agent directly"),
    (r"\b(system|developer) (prompt|message|override)\b", "mentions a system prompt or override"),
    # "Pay now" alone is normal invoice wording, so these need an approval verb or "without review".
    (r"(approve|release|authori[sz]e)( this| the payment| it| the invoice)?( now| immediately| automatically)", "demands immediate approval"),
    (r"(pay|approve|process)[^.\n]{0,30}without (any )?(review|approval|checking|verification|human)", "asks to pay without review"),
    (r"(bypass|skip|override) (the )?(approval|review|policy|limits?|checks?|cap)", "asks to bypass approval or limits"),
    (r"(urgent|immediate|important)[^.\n]{0,40}(change|update|new)[^.\n]{0,40}(bank|account|payment|payout|paypal) (details|information|info|email|address)", "urgent change of payment details"),
    (r"(our|the) (bank|payment|payout|paypal) (details|account|email) (have|has) (changed|been updated)", "claims payment details changed"),
    (r"(send|pay|remit) (all )?(future )?payments? to (this|the following|our new)", "redirects payments to a new destination"),
    (r"do not (tell|inform|notify|contact|call|verify with)", "asks for secrecy or no verification"),
    (r"\b(tool|function)[_ ]?call\b|<\s*/?\s*(tool|function|system)\b", "contains tool-call or markup syntax"),
]

_COMPILED = [(re.compile(p.replace(" ", r"\s+"), re.IGNORECASE), label) for p, label in PHRASES]

INVISIBLE = {"​", "‌", "‍", "⁠", "﻿", "­"}
HIDDEN_HTML = re.compile(
    r"(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*(#fff(fff)?|white)\b|opacity\s*:\s*0(\.0+)?\s*[;\"'])",
    re.IGNORECASE,
)


def _snippet(text: str, start: int, end: int) -> str:
    """The match with a little context, cut at word boundaries."""
    a = max(0, start - 24)
    while a > 0 and not text[a - 1].isspace():
        a -= 1
    b = min(len(text), end + 24)
    while b < len(text) and not text[b].isspace():
        b += 1
    s = " ".join(text[a:b].split())
    return s if len(s) <= 140 else s[:140].rsplit(" ", 1)[0] + "…"


def scan(text: str) -> list[Flag]:
    """Returns INJECTION_SUSPECTED flags with a quoted reason for each finding."""
    flags: list[Flag] = []
    normalized = unicodedata.normalize("NFKC", text)
    seen: set[str] = set()
    for rx, label in _COMPILED:
        m = rx.search(normalized)
        if m and label not in seen:
            seen.add(label)
            flags.append(Flag(code="INJECTION_SUSPECTED", detail=f'{label}: "{_snippet(normalized, m.start(), m.end())}"'))
    hidden = sum(1 for ch in text if ch in INVISIBLE)
    if hidden:
        flags.append(Flag(code="INJECTION_SUSPECTED", detail=f"document contains {hidden} invisible character(s)"))
    m = HIDDEN_HTML.search(text)
    if m:
        flags.append(Flag(code="INJECTION_SUSPECTED", detail=f'document hides text with CSS: "{m.group(0)}"'))
    return flags


def strip_invisible(text: str) -> str:
    return "".join(ch for ch in text if ch not in INVISIBLE)
