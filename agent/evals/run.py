"""Eval harness. Pass-rate tables for the README.

    python -m evals.run                                  # invoices + deliverables, agent only
    python -m evals.run --core http://localhost:8080     # end to end; needs a fresh, seeded core
                                                          # (and CORE_OPERATOR_TOKEN for milestones)
    python -m evals.run --mode live                      # use the model (and record replays)

Prints markdown tables and writes evals/results.md and evals/results.json."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
CORPUS = HERE / "corpus"
PLACEHOLDER = re.compile(r"\{\{(today|due\+(\d+))(?::([^}]*))?\}\}")


def render(text: str, today: date) -> str:
    def sub(m: re.Match) -> str:
        d = today if m.group(1) == "today" else today + timedelta(days=int(m.group(2)))
        return d.strftime(m.group(3) or "%Y-%m-%d")

    return PLACEHOLDER.sub(sub, text)


def ok(b: bool) -> str:
    return "✅" if b else "❌"


# --- Invoices ---------------------------------------------------------------------------------


def run_invoices(client, today: date) -> tuple[list[dict], dict]:
    from cosign_agent.core_client import CoreError
    from cosign_agent.extract import read_invoice, source_hash

    cases = json.loads((CORPUS / "cases.json").read_text(encoding="utf-8"))["cases"]
    rows, hits, total = [], 0, 0
    for case in cases:
        text = render((CORPUS / "invoices" / case["file"]).read_text(encoding="utf-8"), today)
        fields, flags, extractor, error = read_invoice(text)
        row = {"file": case["file"], "kind": case["kind"], "attack": case.get("attack", ""), "extractor": extractor, "flags": [f.code for f in flags]}
        exp = case["fields"]
        if exp is None:
            row["fields_ok"] = fields is None
            hits += int(fields is None)
            total += 1
        elif fields is None:
            row["fields_ok"], row["field_misses"] = False, [f"(unreadable: {error})"]
            total += 6
        else:
            got = fields.model_dump(mode="json")
            expected = dict(exp)
            if "due_offset" in expected:
                off = expected.pop("due_offset")
                expected["due_date"] = None if off is None else (today + timedelta(days=off)).isoformat()
            misses = [k for k, v in expected.items() if got.get(k) != v]
            hits += len(expected) - len(misses)
            total += len(expected)
            row["fields_ok"] = not misses
            row["field_misses"] = [f"{k}: got {got.get(k)!r}, expected {expected[k]!r}" for k in misses]
        row["injection_ok"] = any(f.code == "INJECTION_SUSPECTED" for f in flags) == case["injection"]
        if client:
            if fields is None:
                row["decision"] = "UNREADABLE"
            else:
                try:
                    d = client.propose_invoice(fields, flags, source_hash(text.encode()))
                    row["decision"], row["reasons"] = d["decision"], [r["code"] for r in d["reasons"]]
                except CoreError as e:
                    row["decision"] = "UNREADABLE" if e.status == 422 else f"ERROR {e.status}"
            row["decision_ok"] = row["decision"] == case["decision"] and (not case.get("reason") or case["reason"] in row.get("reasons", []))
        rows.append(row)

    malicious = [r for r in rows if r["kind"] == "malicious"]
    normal = [r for r in rows if r["kind"] == "normal"]
    m = {
        "invoice cases": len(rows),
        "extraction field accuracy": f"{hits / total:.1%}" if total else "-",
        "documents fully extracted": f"{sum(r['fields_ok'] for r in rows)}/{len(rows)}",
        "injection flag correct": f"{sum(r['injection_ok'] for r in rows)}/{len(rows)}",
    }
    if client:
        m["attacks not paid"] = f"{sum(r['decision'] != 'ALLOW' for r in malicious)}/{len(malicious)}"
        m["normal invoices wrongly held"] = f"{sum(r['decision'] != 'ALLOW' for r in normal)}/{len(normal)}"
        m["invoice decisions matching expected"] = f"{sum(r['decision_ok'] for r in rows)}/{len(rows)}"
    return rows, m


# --- Deliverables -------------------------------------------------------------------------------


def run_milestones(core_url: str | None, operator: str | None) -> tuple[list[dict], dict]:
    from cosign_agent.criteria import check_milestone
    from cosign_agent.core_client import CoreClient
    from cosign_agent.models import CheckMilestoneRequest

    cases = json.loads((CORPUS / "milestones.json").read_text(encoding="utf-8"))["cases"]
    e2e = bool(core_url and operator)
    agent = CoreClient(base_url=core_url) if e2e else None
    op = {"authorization": f"Bearer {operator}"}
    rows = []
    for case in cases:
        req = CheckMilestoneRequest(criteria=case["criteria"], evidence=case["evidence"], submit=False)
        results, flags, checker, _ = check_milestone(req)
        agent_verdict = "verified" if all(r.passed for r in results) and not flags else "held"
        row = {"name": case["name"], "kind": case["kind"], "expected": case["expected"], "agent": agent_verdict, "checker": checker,
               "failed": [r.criterion for r in results if not r.passed], "flags": [f.code for f in flags]}
        if e2e:
            # One deal per case: create, fund, deliver, submit the check, read the state back.
            deal = httpx.post(f"{core_url}/v1/deals", headers=op, timeout=15, json={
                "title": f"eval {case['name']}", "seller": "Eval Seller", "seller_email": "seller@eval.example",
                "milestones": [{"title": case["name"], "amount": "10.00", "currency": "USD", "criteria": case["criteria"]}]}).json()
            mid = deal["milestones"][0]["id"]
            httpx.post(f"{core_url}/v1/milestones/{mid}/fund", headers=op, timeout=15).raise_for_status()
            delivered = httpx.post(f"{core_url}/v1/milestones/{mid}/deliver", headers=op, json={"evidence": case["evidence"]}, timeout=15).json()
            res = agent.submit_criteria(mid, delivered["evidence_hash"], results, flags)
            row["core"] = "verified" if res["milestone"]["state"] == "VERIFIED" else "held"
        row["ok"] = row.get("core", agent_verdict) == case["expected"]
        rows.append(row)

    good = [r for r in rows if r["kind"] == "good"]
    not_good = [r for r in rows if r["kind"] != "good"]
    final = lambda r: r.get("core", r["agent"])  # noqa: E731
    m = {
        "deliverable cases": len(rows),
        "good deliverables verified": f"{sum(final(r) == 'verified' for r in good)}/{len(good)}",
        "partial, bad and attack deliverables held": f"{sum(final(r) == 'held' for r in not_good)}/{len(not_good)}",
        "agreement with expected": f"{sum(r['ok'] for r in rows)}/{len(rows)}",
    }
    return rows, m


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", help="Rust core URL for end-to-end decisions (needs a fresh, seeded database)")
    ap.add_argument("--mode", default=os.environ.get("COSIGN_LLM_MODE", "offline"), choices=["offline", "replay", "live"])
    ap.add_argument("--strict", action="store_true", help="exit 1 if any case does not match")
    ap.add_argument("--force", action="store_true", help="run --core even if the ledger is not empty")
    args = ap.parse_args(argv)
    os.environ["COSIGN_LLM_MODE"] = args.mode

    from cosign_agent.core_client import CoreClient

    today = date.today()
    operator = os.environ.get("CORE_OPERATOR_TOKEN")
    client = CoreClient(base_url=args.core) if args.core else None
    if client and operator and not args.force:
        ledger = httpx.get(f"{client.base_url}/v1/ledger", headers={"authorization": f"Bearer {operator}"}, timeout=10).json()
        if ledger.get("payments"):
            print("The core already has payments; duplicates would skew results. Reset the database (docker compose down -v) or pass --force.", file=sys.stderr)
            return 2

    inv_rows, inv_m = run_invoices(client, today)
    ms_rows, ms_m = run_milestones(args.core, operator)

    scope = "end to end" if client else "agent only"
    lines = [f"# Eval results ({today.isoformat()}, reader: {args.mode}, {scope})", "", "| Metric | Value |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in {**inv_m, **ms_m}.items()]
    lines += ["", "## Invoices", "", "| Case | Kind | Fields | Injection flag | " + ("Decision | " if client else "") + "Notes |", "|---|---|---|---|" + ("---|" if client else "") + "---|"]
    for r in inv_rows:
        notes = "; ".join(r.get("field_misses", []))
        if client and not r["decision_ok"]:
            notes = (notes + "; " if notes else "") + f"reasons {r.get('reasons', [])}"
        dec = f" {ok(r['decision_ok'])} {r['decision']} |" if client else ""
        kind = r["kind"] + (f" ({r['attack']})" if r["attack"] else "")
        lines.append(f"| {r['file']} | {kind} | {ok(r['fields_ok'])} | {ok(r['injection_ok'])} |{dec} {notes} |")
    lines += ["", "## Deliverables", "", "| Case | Kind | Expected | Agent | " + ("Core | " if args.core and operator else "") + "Notes |", "|---|---|---|---|" + ("---|" if args.core and operator else "") + "---|"]
    for r in ms_rows:
        core_col = f" {r['core']} |" if "core" in r else ""
        notes = "; ".join(filter(None, [("failed: " + ", ".join(r["failed"])) if r["failed"] else "", ("flags: " + ", ".join(r["flags"])) if r["flags"] else ""]))
        lines.append(f"| {r['name']} | {r['kind']} | {r['expected']} | {ok(r['ok'])} {r['agent']} |{core_col} {notes} |")
    report = "\n".join(lines)
    print(report)
    (HERE / "results.md").write_text(report + "\n", encoding="utf-8")
    (HERE / "results.json").write_text(json.dumps({"invoice_metrics": inv_m, "deliverable_metrics": ms_m, "invoices": inv_rows, "deliverables": ms_rows}, indent=2, ensure_ascii=False), encoding="utf-8")

    all_ok = all(r["fields_ok"] and r["injection_ok"] and r.get("decision_ok", True) for r in inv_rows) and all(r["ok"] for r in ms_rows)
    return 1 if args.strict and not all_ok else 0


if __name__ == "__main__":
    sys.exit(main())
