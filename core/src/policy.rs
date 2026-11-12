//! The policy engine. The AI proposes; this module decides.
//!
//! Two guarantees live here:
//! 1. The final decision is the most severe outcome of all rules. AI flags can add reasons
//!    or raise severity and can never lower it, because a flag can only ever add a reason.
//! 2. `Authorized<T>` can only be built inside this module, by `authorize_allowed` (from a
//!    fresh `Evaluation` that came out of `evaluate`) or `authorize_approved` (from a stored
//!    RequireApproval decision plus a matching human approval). The PayPal executor accepts
//!    nothing else, so no code path pays without a decision.

use crate::money::Money;
use crate::similarity::{names_look_alike, normalize_invoice_number, normalize_name};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

// --- Reasons and severity ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    Allow,
    RequireApproval,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonCode {
    VendorUnknown,
    PayoutDetailsChanged,
    OverInvoiceCap,
    OverDailyCap,
    MandateExpired,
    DuplicateInvoice,
    Velocity,
    DueDateImplausible,
    InjectionSuspected,
    CriteriaFailed,
    /// The agent could not produce a valid reading of the document (fail closed).
    UnreadableDocument,
    /// Any other flag the agent raises. Unknown flags still escalate.
    AiFlagged,
}

impl ReasonCode {
    /// Each code has one fixed effect, so severity can be audited from the code alone.
    pub fn severity(self) -> Severity {
        use ReasonCode::*;
        match self {
            PayoutDetailsChanged | MandateExpired | DuplicateInvoice => Severity::Block,
            VendorUnknown | OverInvoiceCap | OverDailyCap | Velocity | DueDateImplausible | InjectionSuspected
            | CriteriaFailed | UnreadableDocument | AiFlagged => Severity::RequireApproval,
        }
    }

    pub fn as_str(self) -> &'static str {
        use ReasonCode::*;
        match self {
            VendorUnknown => "VENDOR_UNKNOWN",
            PayoutDetailsChanged => "PAYOUT_DETAILS_CHANGED",
            OverInvoiceCap => "OVER_INVOICE_CAP",
            OverDailyCap => "OVER_DAILY_CAP",
            MandateExpired => "MANDATE_EXPIRED",
            DuplicateInvoice => "DUPLICATE_INVOICE",
            Velocity => "VELOCITY",
            DueDateImplausible => "DUE_DATE_IMPLAUSIBLE",
            InjectionSuspected => "INJECTION_SUSPECTED",
            CriteriaFailed => "CRITERIA_FAILED",
            UnreadableDocument => "UNREADABLE_DOCUMENT",
            AiFlagged => "AI_FLAGGED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reason {
    pub code: ReasonCode,
    pub detail: String,
    /// "rule" for Rust rules, "agent" for flags raised by the Python service.
    pub source: String,
}

impl Reason {
    fn rule(code: ReasonCode, detail: impl Into<String>) -> Self {
        Reason { code, detail: detail.into(), source: "rule".into() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    RequireApproval(Vec<Reason>),
    Block(Vec<Reason>),
}

impl Decision {
    pub fn severity(&self) -> Severity {
        match self {
            Decision::Allow => Severity::Allow,
            Decision::RequireApproval(_) => Severity::RequireApproval,
            Decision::Block(_) => Severity::Block,
        }
    }

    pub fn reasons(&self) -> &[Reason] {
        match self {
            Decision::Allow => &[],
            Decision::RequireApproval(r) | Decision::Block(r) => r,
        }
    }

    /// Combines reasons into the most severe outcome. Any reason means at least approval.
    pub fn from_reasons(mut reasons: Vec<Reason>) -> Self {
        reasons.sort_by(|a, b| b.code.severity().cmp(&a.code.severity()).then(a.code.cmp(&b.code)));
        match reasons.iter().map(|r| r.code.severity()).max() {
            None | Some(Severity::Allow) => Decision::Allow,
            Some(Severity::RequireApproval) => Decision::RequireApproval(reasons),
            Some(Severity::Block) => Decision::Block(reasons),
        }
    }

    pub fn outcome_str(&self) -> &'static str {
        match self {
            Decision::Allow => "ALLOW",
            Decision::RequireApproval(_) => "REQUIRE_APPROVAL",
            Decision::Block(_) => "BLOCK",
        }
    }

    pub fn from_stored(outcome: &str, reasons: Vec<Reason>) -> Option<Self> {
        match outcome {
            "ALLOW" if reasons.is_empty() => Some(Decision::Allow),
            "REQUIRE_APPROVAL" => Some(Decision::RequireApproval(reasons)),
            "BLOCK" => Some(Decision::Block(reasons)),
            _ => None,
        }
    }
}

// --- Inputs ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MandateRules {
    pub currency: String,
    pub per_invoice_cap_cents: i64,
    pub daily_cap_cents: i64,
    pub velocity_max_payments: u32,
    pub velocity_window_minutes: u32,
    pub due_date_max_past_days: i64,
    pub due_date_max_future_days: i64,
}

impl Default for MandateRules {
    fn default() -> Self {
        MandateRules {
            currency: "USD".into(),
            per_invoice_cap_cents: 200_000,
            daily_cap_cents: 500_000,
            velocity_max_payments: 5,
            velocity_window_minutes: 60,
            due_date_max_past_days: 60,
            due_date_max_future_days: 120,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Mandate {
    pub id: Uuid,
    pub owner_id: String,
    pub rules: MandateRules,
    pub hash: String,
    pub expires_at: DateTime<Utc>,
}

/// Hash shown on every decision so anyone can prove which limits applied.
pub fn mandate_hash(owner_id: &str, rules: &MandateRules, expires_at: DateTime<Utc>) -> String {
    let canonical = serde_json::json!({
        "owner_id": owner_id,
        "rules": rules,
        "expires_at": expires_at.timestamp(),
    });
    sha256_hex(canonical.to_string().as_bytes())
}

#[derive(Debug, Clone)]
pub struct VendorRecord {
    pub id: Uuid,
    pub name: String,
    pub payout_hash: String,
    /// Deactivated vendors stay known, so an invoice naming one is still checked against its
    /// payout record (a mismatch is blocked), but it is never paid without a signature.
    pub active: bool,
}

/// Payout details are compared by hash so the vendor table never needs re-reading in clear.
pub fn payout_hash(email: &str) -> String {
    sha256_hex(email.trim().to_lowercase().as_bytes())
}

#[derive(Debug, Clone)]
pub struct PriorInvoice {
    pub vendor_id: Option<Uuid>,
    pub vendor_name: String,
    pub number: String,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiFlag {
    pub code: String,
    #[serde(default)]
    pub detail: String,
}

impl AiFlag {
    fn to_reason(&self) -> Reason {
        let code = match self.code.as_str() {
            "INJECTION_SUSPECTED" => ReasonCode::InjectionSuspected,
            "CRITERIA_FAILED" => ReasonCode::CriteriaFailed,
            "UNREADABLE" | "UNREADABLE_DOCUMENT" => ReasonCode::UnreadableDocument,
            _ => ReasonCode::AiFlagged,
        };
        let detail = if self.detail.is_empty() { self.code.clone() } else { self.detail.clone() };
        Reason { code, detail, source: "agent".into() }
    }
}

#[derive(Debug, Clone)]
pub struct PaymentRequest {
    pub vendor_name: String,
    pub invoice_number: String,
    pub amount: Money,
    pub due_date: Option<NaiveDate>,
    pub payout_email: String,
    pub ai_flags: Vec<AiFlag>,
}

pub struct Context<'a> {
    pub now: DateTime<Utc>,
    pub mandate: &'a Mandate,
    pub vendors: &'a [VendorRecord],
    pub prior_invoices: &'a [PriorInvoice],
    /// Sum of today's payments in the mandate currency that are allowed, approved, submitted or paid.
    pub committed_today_cents: i64,
    /// Payments decided ALLOW or approved inside the velocity window.
    pub payments_in_velocity_window: u32,
}

// --- Evaluation -------------------------------------------------------------------------

/// The result of `evaluate`. Sealed: only this module can create one, so `authorize_allowed`
/// can trust that an Allow inside it came from the rules.
#[derive(Debug, Clone)]
#[allow(clippy::manual_non_exhaustive)] // the seal must also stop in-crate construction
pub struct Evaluation {
    pub decision: Decision,
    pub vendor_id: Option<Uuid>,
    _seal: (),
}

pub fn evaluate(req: &PaymentRequest, ctx: &Context<'_>) -> Evaluation {
    let mut reasons = Vec::new();
    let rules = &ctx.mandate.rules;

    // Vendor identity.
    let wanted = normalize_name(&req.vendor_name);
    let vendor = ctx.vendors.iter().find(|v| normalize_name(&v.name) == wanted && !wanted.is_empty());
    match vendor {
        Some(v) => {
            if payout_hash(&req.payout_email) != v.payout_hash {
                reasons.push(Reason::rule(
                    ReasonCode::PayoutDetailsChanged,
                    format!("payout email differs from the record for {}", v.name),
                ));
            }
            if !v.active {
                reasons.push(Reason::rule(
                    ReasonCode::VendorUnknown,
                    format!("{} was deactivated and is not on the approved vendor list", v.name),
                ));
            }
        }
        None => {
            let lookalike = ctx.vendors.iter().find(|v| names_look_alike(&v.name, &req.vendor_name));
            let detail = match lookalike {
                Some(v) => format!("\"{}\" is not approved and resembles approved vendor \"{}\"", req.vendor_name, v.name),
                None => format!("\"{}\" is not on the approved vendor list", req.vendor_name),
            };
            reasons.push(Reason::rule(ReasonCode::VendorUnknown, detail));
        }
    }

    // Mandate validity.
    if ctx.now >= ctx.mandate.expires_at {
        reasons.push(Reason::rule(
            ReasonCode::MandateExpired,
            format!("mandate expired at {}", ctx.mandate.expires_at.to_rfc3339()),
        ));
    }

    // Caps.
    if req.amount.currency != rules.currency {
        reasons.push(Reason::rule(
            ReasonCode::OverInvoiceCap,
            format!("currency {} is not covered by the mandate ({})", req.amount.currency, rules.currency),
        ));
    } else {
        if req.amount.cents > rules.per_invoice_cap_cents {
            reasons.push(Reason::rule(
                ReasonCode::OverInvoiceCap,
                format!("{} is above the per-invoice cap of {}", req.amount, cents_str(rules.per_invoice_cap_cents, &rules.currency)),
            ));
        }
        let after = ctx.committed_today_cents.saturating_add(req.amount.cents);
        if after > rules.daily_cap_cents {
            reasons.push(Reason::rule(
                ReasonCode::OverDailyCap,
                format!(
                    "today's total would reach {} against a daily cap of {}",
                    cents_str(after, &rules.currency),
                    cents_str(rules.daily_cap_cents, &rules.currency)
                ),
            ));
        }
    }

    // Duplicates: same vendor (or a lookalike name) with the same normalized number.
    let number = normalize_invoice_number(&req.invoice_number);
    for prior in ctx.prior_invoices {
        let same_vendor = match (vendor, prior.vendor_id) {
            (Some(v), Some(pid)) => v.id == pid,
            _ => names_look_alike(&prior.vendor_name, &req.vendor_name),
        };
        if !same_vendor || normalize_invoice_number(&prior.number) != number || number.is_empty() {
            continue;
        }
        let detail = if prior.amount == req.amount {
            if prior.number == req.invoice_number {
                format!("invoice {} for {} was already submitted", prior.number, prior.amount)
            } else {
                format!("\"{}\" matches earlier invoice \"{}\" for the same amount", req.invoice_number, prior.number)
            }
        } else {
            format!("invoice number {} was already used for {}", prior.number, prior.amount)
        };
        reasons.push(Reason::rule(ReasonCode::DuplicateInvoice, detail));
        break;
    }

    // Velocity.
    if ctx.payments_in_velocity_window + 1 > rules.velocity_max_payments {
        reasons.push(Reason::rule(
            ReasonCode::Velocity,
            format!(
                "{} payments already in the last {} minutes (limit {})",
                ctx.payments_in_velocity_window, rules.velocity_window_minutes, rules.velocity_max_payments
            ),
        ));
    }

    // Due date plausibility.
    let today = ctx.now.date_naive();
    match req.due_date {
        None => reasons.push(Reason::rule(ReasonCode::DueDateImplausible, "the invoice has no due date")),
        Some(due) => {
            let days = (due - today).num_days();
            if days < -rules.due_date_max_past_days {
                reasons.push(Reason::rule(ReasonCode::DueDateImplausible, format!("due date {due} is {} days in the past", -days)));
            } else if days > rules.due_date_max_future_days {
                reasons.push(Reason::rule(ReasonCode::DueDateImplausible, format!("due date {due} is {days} days in the future")));
            }
        }
    }

    // Agent flags: append only. There is no code path by which a flag removes a reason.
    reasons.extend(req.ai_flags.iter().map(AiFlag::to_reason));

    Evaluation { decision: Decision::from_reasons(reasons), vendor_id: vendor.map(|v| v.id), _seal: () }
}

fn cents_str(cents: i64, currency: &str) -> String {
    format!("{}.{:02} {currency}", cents / 100, cents % 100)
}

// --- Authorization ------------------------------------------------------------------------

/// Proof that a decision allows this payload. Fields are private and there is no public
/// constructor, so outside this module the only way to get one is the two functions below.
#[derive(Debug)]
pub struct Authorized<T> {
    inner: T,
    decision_id: Uuid,
    _private: (),
}

impl<T> Authorized<T> {
    pub fn inner(&self) -> &T {
        &self.inner
    }
    pub fn decision_id(&self) -> Uuid {
        self.decision_id
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("the decision does not allow payment")]
    NotAllowed,
    #[error("blocked decisions cannot be approved")]
    Blocked,
    #[error("the approval was a denial")]
    Denied,
    #[error("the approval does not match the decision it claims to approve")]
    HashMismatch,
}

/// A payment the rules allowed outright.
pub fn authorize_allowed<T>(evaluation: &Evaluation, decision_id: Uuid, payload: T) -> Result<Authorized<T>, AuthError> {
    match evaluation.decision {
        Decision::Allow => Ok(Authorized { inner: payload, decision_id, _private: () }),
        _ => Err(AuthError::NotAllowed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Approve,
    Deny,
}

/// A decision as stored, plus the hash a human approver must quote.
pub struct StoredDecision {
    pub id: Uuid,
    pub decision: Decision,
    pub hash: String,
}

pub struct ApprovalInput<'a> {
    pub verdict: Verdict,
    pub decision_hash: &'a str,
}

/// A payment a human approved after the rules asked for approval. Blocks stay blocked.
pub fn authorize_approved<T>(stored: &StoredDecision, approval: &ApprovalInput<'_>, payload: T) -> Result<Authorized<T>, AuthError> {
    if approval.decision_hash != stored.hash {
        return Err(AuthError::HashMismatch);
    }
    match (&stored.decision, approval.verdict) {
        (Decision::Block(_), _) => Err(AuthError::Blocked),
        (_, Verdict::Deny) => Err(AuthError::Denied),
        (Decision::RequireApproval(_), Verdict::Approve) => {
            Ok(Authorized { inner: payload, decision_id: stored.id, _private: () })
        }
        (Decision::Allow, Verdict::Approve) => Err(AuthError::NotAllowed),
    }
}

/// The hash a decision is known by. An approval quotes it, so approving a decision that has
/// since changed (or a different payment) fails.
pub fn decision_hash(
    payment_id: Uuid,
    decision: &Decision,
    mandate_hash: &str,
    source_hash: &str,
    amount: &Money,
    payout_email: &str,
) -> String {
    let canonical = serde_json::json!({
        "payment_id": payment_id,
        "outcome": decision.outcome_str(),
        "reasons": decision.reasons(),
        "mandate_hash": mandate_hash,
        "source_hash": source_hash,
        "amount": amount,
        "payout_email": payout_email.trim().to_lowercase(),
    });
    sha256_hex(canonical.to_string().as_bytes())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

// --- Milestones ---------------------------------------------------------------------------

/// One acceptance criterion as judged by the agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriterionResult {
    pub criterion: String,
    pub passed: bool,
    #[serde(default)]
    pub reason: String,
    /// 0.0 to 1.0.
    #[serde(default)]
    pub confidence: f64,
}

/// Below this confidence a "pass" counts as unsure, which holds the milestone.
pub const MIN_PASS_CONFIDENCE: f64 = 0.6;

/// Decides whether delivered work is verified. Allow = every criterion passed with enough
/// confidence and nothing was flagged. Anything else holds the milestone for the buyer.
/// Like payments, agent flags only ever add reasons.
pub fn evaluate_criteria(criteria: &[String], results: &[CriterionResult], flags: &[AiFlag]) -> Decision {
    let mut reasons = Vec::new();
    for c in criteria {
        match results.iter().find(|r| r.criterion.trim() == c.trim()) {
            None => reasons.push(Reason { code: ReasonCode::CriteriaFailed, detail: format!("no result for criterion \"{c}\""), source: "rule".into() }),
            Some(r) if !r.passed => reasons.push(Reason {
                code: ReasonCode::CriteriaFailed,
                detail: format!("\"{c}\" failed: {}", r.reason),
                source: "agent".into(),
            }),
            Some(r) if r.confidence.is_nan() || r.confidence < MIN_PASS_CONFIDENCE => reasons.push(Reason {
                code: ReasonCode::CriteriaFailed,
                detail: format!("\"{c}\" passed with low confidence ({:.2})", r.confidence),
                source: "rule".into(),
            }),
            Some(_) => {}
        }
    }
    if criteria.is_empty() {
        reasons.push(Reason { code: ReasonCode::CriteriaFailed, detail: "milestone has no acceptance criteria".into(), source: "rule".into() });
    }
    reasons.extend(flags.iter().map(AiFlag::to_reason));
    Decision::from_reasons(reasons)
}

/// What the core knows about a milestone when asked to release it.
pub struct StoredMilestone {
    pub id: Uuid,
    pub state: crate::state::MilestoneState,
    pub authorization_id: Option<String>,
    pub hold_reasons: Vec<Reason>,
    pub buyer_accepted_hold: bool,
}

/// Release (capture, then pay the seller) is allowed only from Verified with a live
/// authorization. A milestone reaches Verified either because every criterion passed or
/// because the buyer explicitly accepted it despite a hold.
pub fn authorize_release<T>(m: &StoredMilestone, payload: T) -> Result<Authorized<T>, AuthError> {
    if m.state != crate::state::MilestoneState::Verified || m.authorization_id.is_none() {
        return Err(AuthError::NotAllowed);
    }
    if !m.hold_reasons.is_empty() && !m.buyer_accepted_hold {
        return Err(AuthError::NotAllowed);
    }
    Ok(Authorized { inner: payload, decision_id: m.id, _private: () })
}

/// Re-sending a payment whose first attempt has an unknown outcome. Allowed only for a
/// payment that was already authorized once: an ALLOW decision, or a REQUIRE_APPROVAL
/// decision with a matching approval. The caller reuses the original idempotency key, so
/// PayPal pays at most once.
pub fn authorize_resubmission<T>(
    stored: &StoredDecision,
    approval: Option<&ApprovalInput<'_>>,
    payload: T,
) -> Result<Authorized<T>, AuthError> {
    match (&stored.decision, approval) {
        (Decision::Allow, _) => Ok(Authorized { inner: payload, decision_id: stored.id, _private: () }),
        (Decision::RequireApproval(_), Some(a)) => authorize_approved(stored, a, payload),
        (Decision::RequireApproval(_), None) => Err(AuthError::NotAllowed),
        (Decision::Block(_), _) => Err(AuthError::Blocked),
    }
}

// --- Tests ----------------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    pub fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 17, 9, 0, 0).unwrap()
    }

    pub fn mandate() -> Mandate {
        let rules = MandateRules::default();
        let expires_at = now() + Duration::days(30);
        Mandate { id: Uuid::nil(), owner_id: "demo".into(), hash: mandate_hash("demo", &rules, expires_at), rules, expires_at }
    }

    pub fn vendors() -> Vec<VendorRecord> {
        vec![
            VendorRecord { id: Uuid::from_u128(1), name: "Northwind Design Studio".into(), payout_hash: payout_hash("billing@northwind.example"), active: true },
            VendorRecord { id: Uuid::from_u128(2), name: "Contoso Legal LLP".into(), payout_hash: payout_hash("accounts@contoso.example"), active: true },
        ]
    }

    pub fn normal_request() -> PaymentRequest {
        PaymentRequest {
            vendor_name: "Northwind Design Studio".into(),
            invoice_number: "NW-1042".into(),
            amount: Money::parse("850.00", "USD").unwrap(),
            due_date: Some(NaiveDate::from_ymd_opt(2026, 10, 31).unwrap()),
            payout_email: "billing@northwind.example".into(),
            ai_flags: vec![],
        }
    }

    fn run(req: &PaymentRequest, prior: &[PriorInvoice], today: i64, window: u32) -> Decision {
        let m = mandate();
        let v = vendors();
        evaluate(req, &Context { now: now(), mandate: &m, vendors: &v, prior_invoices: prior, committed_today_cents: today, payments_in_velocity_window: window }).decision
    }

    fn codes(d: &Decision) -> Vec<ReasonCode> {
        d.reasons().iter().map(|r| r.code).collect()
    }

    #[test]
    fn normal_invoice_is_allowed() {
        assert_eq!(run(&normal_request(), &[], 0, 0), Decision::Allow);
    }

    #[test]
    fn vendor_name_variants_still_match() {
        let mut r = normal_request();
        r.vendor_name = "NORTHWIND design studio".into();
        assert_eq!(run(&r, &[], 0, 0), Decision::Allow);
    }

    #[test]
    fn rule_table() {
        type Case = (&'static str, fn(&mut PaymentRequest), ReasonCode, Severity);
        let cases: Vec<Case> = vec![
            ("unknown vendor", |r| r.vendor_name = "Fabrikam Freight".into(), ReasonCode::VendorUnknown, Severity::RequireApproval),
            ("lookalike vendor", |r| { r.vendor_name = "Northwlnd Design Studio".into(); r.payout_email = "pay@northwlnd.example".into(); }, ReasonCode::VendorUnknown, Severity::RequireApproval),
            ("changed payout", |r| r.payout_email = "new-bank@evil.example".into(), ReasonCode::PayoutDetailsChanged, Severity::Block),
            ("over invoice cap", |r| r.amount = Money::parse("2000.01", "USD").unwrap(), ReasonCode::OverInvoiceCap, Severity::RequireApproval),
            ("wrong currency", |r| r.amount = Money::parse("10.00", "EUR").unwrap(), ReasonCode::OverInvoiceCap, Severity::RequireApproval),
            ("missing due date", |r| r.due_date = None, ReasonCode::DueDateImplausible, Severity::RequireApproval),
            ("due long ago", |r| r.due_date = NaiveDate::from_ymd_opt(2025, 1, 1), ReasonCode::DueDateImplausible, Severity::RequireApproval),
            ("due far ahead", |r| r.due_date = NaiveDate::from_ymd_opt(2027, 12, 1), ReasonCode::DueDateImplausible, Severity::RequireApproval),
            ("injection flag", |r| r.ai_flags.push(AiFlag { code: "INJECTION_SUSPECTED".into(), detail: "hidden text".into() }), ReasonCode::InjectionSuspected, Severity::RequireApproval),
            ("unreadable", |r| r.ai_flags.push(AiFlag { code: "UNREADABLE".into(), detail: String::new() }), ReasonCode::UnreadableDocument, Severity::RequireApproval),
            ("unknown flag", |r| r.ai_flags.push(AiFlag { code: "SOMETHING_NEW".into(), detail: String::new() }), ReasonCode::AiFlagged, Severity::RequireApproval),
        ];
        for (name, mutate, code, severity) in cases {
            let mut r = normal_request();
            mutate(&mut r);
            let d = run(&r, &[], 0, 0);
            assert!(codes(&d).contains(&code), "{name}: expected {code:?} in {:?}", codes(&d));
            assert_eq!(d.severity(), severity, "{name}");
        }
    }

    #[test]
    fn daily_cap() {
        assert_eq!(run(&normal_request(), &[], 415_000, 0), Decision::Allow); // exactly at cap
        let d = run(&normal_request(), &[], 415_001, 0);
        assert_eq!(codes(&d), vec![ReasonCode::OverDailyCap]);
    }

    #[test]
    fn velocity() {
        assert_eq!(run(&normal_request(), &[], 0, 4), Decision::Allow);
        assert_eq!(codes(&run(&normal_request(), &[], 0, 5)), vec![ReasonCode::Velocity]);
    }

    #[test]
    fn deactivated_vendor_is_held_and_still_guards_its_payout() {
        let m = mandate();
        let mut v = vendors();
        v[0].active = false;
        let ctx = Context { now: now(), mandate: &m, vendors: &v, prior_invoices: &[], committed_today_cents: 0, payments_in_velocity_window: 0 };
        // Right email: waits for a signature instead of paying itself.
        let held = evaluate(&normal_request(), &ctx);
        assert_eq!(codes(&held.decision), vec![ReasonCode::VendorUnknown]);
        assert_eq!(held.decision.severity(), Severity::RequireApproval);
        assert_eq!(held.vendor_id, Some(Uuid::from_u128(1)));
        // Someone reusing the old vendor's name with new payout details is still blocked.
        let mut req = normal_request();
        req.payout_email = "new-bank@evil.example".into();
        let blocked = evaluate(&req, &ctx).decision;
        assert_eq!(blocked.severity(), Severity::Block);
        assert!(codes(&blocked).contains(&ReasonCode::PayoutDetailsChanged));
    }

    #[test]
    fn expired_mandate_blocks() {
        let mut m = mandate();
        m.expires_at = now() - Duration::seconds(1);
        let v = vendors();
        let d = evaluate(&normal_request(), &Context { now: now(), mandate: &m, vendors: &v, prior_invoices: &[], committed_today_cents: 0, payments_in_velocity_window: 0 }).decision;
        assert_eq!(codes(&d), vec![ReasonCode::MandateExpired]);
        assert_eq!(d.severity(), Severity::Block);
    }

    #[test]
    fn duplicates() {
        let prior = |number: &str, amount: &str| PriorInvoice {
            vendor_id: Some(Uuid::from_u128(1)),
            vendor_name: "Northwind Design Studio".into(),
            number: number.into(),
            amount: Money::parse(amount, "USD").unwrap(),
        };
        // Exact duplicate.
        assert_eq!(codes(&run(&normal_request(), &[prior("NW-1042", "850.00")], 0, 0)), vec![ReasonCode::DuplicateInvoice]);
        // Punctuation and zero-padding variant.
        assert_eq!(codes(&run(&normal_request(), &[prior("nw01042", "850.00")], 0, 0)), vec![ReasonCode::DuplicateInvoice]);
        // Number reused with a different amount.
        assert_eq!(codes(&run(&normal_request(), &[prior("NW-1042", "900.00")], 0, 0)), vec![ReasonCode::DuplicateInvoice]);
        // A monthly retainer: same amount, next number. Not a duplicate.
        assert_eq!(run(&normal_request(), &[prior("NW-1041", "850.00")], 0, 0), Decision::Allow);
        // Same number from a different vendor is fine.
        let other = PriorInvoice { vendor_id: Some(Uuid::from_u128(2)), vendor_name: "Contoso Legal LLP".into(), ..prior("NW-1042", "850.00") };
        assert_eq!(run(&normal_request(), &[other], 0, 0), Decision::Allow);
        // A lookalike vendor resubmitting a known invoice is a duplicate and unknown.
        let mut r = normal_request();
        r.vendor_name = "Northwind Design Studios".into();
        let d = run(&r, &[prior("NW-1042", "850.00")], 0, 0);
        assert!(codes(&d).contains(&ReasonCode::DuplicateInvoice));
        assert!(codes(&d).contains(&ReasonCode::VendorUnknown));
    }

    #[test]
    fn most_severe_wins_and_blocks_sort_first() {
        let mut r = normal_request();
        r.payout_email = "x@evil.example".into();
        r.amount = Money::parse("5000.00", "USD").unwrap();
        let d = run(&r, &[], 0, 0);
        assert_eq!(d.severity(), Severity::Block);
        assert_eq!(d.reasons()[0].code, ReasonCode::PayoutDetailsChanged);
    }

    #[test]
    fn authorize_allowed_only_for_allow() {
        let m = mandate();
        let v = vendors();
        let ctx = Context { now: now(), mandate: &m, vendors: &v, prior_invoices: &[], committed_today_cents: 0, payments_in_velocity_window: 0 };
        let ok = evaluate(&normal_request(), &ctx);
        assert!(authorize_allowed(&ok, Uuid::nil(), ()).is_ok());
        let mut bad = normal_request();
        bad.vendor_name = "Unknown Co".into();
        let flagged = evaluate(&bad, &ctx);
        assert_eq!(authorize_allowed(&flagged, Uuid::nil(), ()).unwrap_err(), AuthError::NotAllowed);
    }

    #[test]
    fn approvals() {
        let needs = StoredDecision { id: Uuid::nil(), decision: Decision::RequireApproval(vec![Reason::rule(ReasonCode::VendorUnknown, "x")]), hash: "h1".into() };
        let blocked = StoredDecision { id: Uuid::nil(), decision: Decision::Block(vec![Reason::rule(ReasonCode::PayoutDetailsChanged, "x")]), hash: "h2".into() };
        let approve = |h| ApprovalInput { verdict: Verdict::Approve, decision_hash: h };
        assert!(authorize_approved(&needs, &approve("h1"), ()).is_ok());
        assert_eq!(authorize_approved(&needs, &approve("other"), ()).unwrap_err(), AuthError::HashMismatch);
        assert_eq!(authorize_approved(&needs, &ApprovalInput { verdict: Verdict::Deny, decision_hash: "h1" }, ()).unwrap_err(), AuthError::Denied);
        assert_eq!(authorize_approved(&blocked, &approve("h2"), ()).unwrap_err(), AuthError::Blocked);
    }

    #[test]
    fn decision_hash_changes_with_inputs() {
        let a = Money::parse("1.00", "USD").unwrap();
        let h1 = decision_hash(Uuid::nil(), &Decision::Allow, "m", "s", &a, "x@y");
        assert_eq!(h1, decision_hash(Uuid::nil(), &Decision::Allow, "m", "s", &a, " X@Y "));
        assert_ne!(h1, decision_hash(Uuid::nil(), &Decision::Allow, "m2", "s", &a, "x@y"));
        assert_ne!(h1, decision_hash(Uuid::nil(), &Decision::Allow, "m", "s", &a, "z@y"));
    }

    // --- Property tests: the invariants the blueprint names -------------------------------

    use proptest::prelude::*;

    fn arb_money() -> impl Strategy<Value = Money> {
        (1i64..1_000_000, prop::sample::select(vec!["USD", "EUR"])).prop_map(|(c, cur)| Money { cents: c, currency: cur.into() })
    }

    fn arb_flag() -> impl Strategy<Value = AiFlag> {
        (prop::sample::select(vec!["INJECTION_SUSPECTED", "CRITERIA_FAILED", "UNREADABLE", "LOW_RISK", "SAFE_TO_PAY", "ALLOW", ""]), ".{0,20}")
            .prop_map(|(code, detail)| AiFlag { code: code.into(), detail })
    }

    fn arb_request() -> impl Strategy<Value = PaymentRequest> {
        (
            prop::sample::select(vec!["Northwind Design Studio", "Contoso Legal LLP", "Northwlnd Design Studio", "Fabrikam", "contoso legal llp"]),
            "[A-Z]{0,3}-?[0-9]{1,5}",
            arb_money(),
            prop::option::of(-400i64..400),
            prop::sample::select(vec!["billing@northwind.example", "accounts@contoso.example", "attacker@evil.example"]),
            prop::collection::vec(arb_flag(), 0..3),
        )
            .prop_map(|(vendor, number, amount, due, email, flags)| PaymentRequest {
                vendor_name: vendor.into(),
                invoice_number: number,
                amount,
                due_date: due.map(|d| now().date_naive() + Duration::days(d)),
                payout_email: email.into(),
                ai_flags: flags,
            })
    }

    proptest! {
        #[test]
        fn unknown_vendor_is_never_allowed(name in "[A-Za-z0-9 .&-]{1,40}", amount in 1i64..10_000, window in 0u32..3) {
            let known = vendors();
            prop_assume!(known.iter().all(|v| normalize_name(&v.name) != normalize_name(&name)));
            let mut r = normal_request();
            r.vendor_name = name;
            r.amount = Money { cents: amount, currency: "USD".into() };
            let d = run(&r, &[], 0, window);
            prop_assert_ne!(d.severity(), Severity::Allow);
            prop_assert!(codes(&d).contains(&ReasonCode::VendorUnknown));
        }

        #[test]
        fn agent_flags_never_lower_severity(req in arb_request(), today in 0i64..600_000, window in 0u32..8) {
            let mut without = req.clone();
            without.ai_flags.clear();
            let with_flags = run(&req, &[], today, window);
            let base = run(&without, &[], today, window);
            prop_assert!(with_flags.severity() >= base.severity());
            // Every rule reason survives the flags.
            for r in base.reasons() {
                prop_assert!(with_flags.reasons().contains(r));
            }
            // Any flag at all means a human looks at it.
            if !req.ai_flags.is_empty() {
                prop_assert!(with_flags.severity() >= Severity::RequireApproval);
            }
        }

        #[test]
        fn daily_cap_never_exceeded_by_auto_allowed_payments(amounts in prop::collection::vec(1i64..300_000, 1..40)) {
            let mut m = mandate();
            m.rules.velocity_max_payments = u32::MAX;
            let v = vendors();
            let mut committed = 0i64;
            for (i, cents) in amounts.into_iter().enumerate() {
                let mut r = normal_request();
                r.invoice_number = format!("NW-{i}");
                r.amount = Money { cents, currency: "USD".into() };
                let ctx = Context { now: now(), mandate: &m, vendors: &v, prior_invoices: &[], committed_today_cents: committed, payments_in_velocity_window: 0 };
                if evaluate(&r, &ctx).decision == Decision::Allow {
                    committed += cents;
                }
                prop_assert!(committed <= m.rules.daily_cap_cents);
            }
        }

        #[test]
        fn severity_is_the_max_of_reason_severities(req in arb_request(), today in 0i64..600_000) {
            let d = run(&req, &[], today, 0);
            let max = d.reasons().iter().map(|r| r.code.severity()).max().unwrap_or(Severity::Allow);
            prop_assert_eq!(d.severity(), max);
        }
    }


    #[test]
    fn criteria_all_pass() {
        let c = vec!["has a logo".to_string(), "dark mode".to_string()];
        let r = vec![
            CriterionResult { criterion: "has a logo".into(), passed: true, reason: String::new(), confidence: 0.9 },
            CriterionResult { criterion: "dark mode".into(), passed: true, reason: String::new(), confidence: 0.7 },
        ];
        assert_eq!(evaluate_criteria(&c, &r, &[]), Decision::Allow);
    }

    #[test]
    fn criteria_failures_hold() {
        let c = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let r = vec![
            CriterionResult { criterion: "a".into(), passed: false, reason: "missing".into(), confidence: 0.9 },
            CriterionResult { criterion: "b".into(), passed: true, reason: String::new(), confidence: 0.3 },
        ];
        let d = evaluate_criteria(&c, &r, &[]);
        assert_eq!(d.severity(), Severity::RequireApproval);
        assert_eq!(d.reasons().len(), 3, "failed, low confidence, missing");
        assert_eq!(evaluate_criteria(&[], &[], &[]).severity(), Severity::RequireApproval);
        // NaN confidence is not a pass.
        let nan = vec![CriterionResult { criterion: "a".into(), passed: true, reason: String::new(), confidence: f64::NAN }];
        assert_ne!(evaluate_criteria(&c[..1], &nan, &[]), Decision::Allow);
    }

    #[test]
    fn release_needs_verified_and_accepted_holds() {
        use crate::state::MilestoneState as M;
        let m = |state, auth: Option<&str>, holds: Vec<Reason>, accepted| StoredMilestone { id: Uuid::nil(), state, authorization_id: auth.map(str::to_string), hold_reasons: holds, buyer_accepted_hold: accepted };
        assert!(authorize_release(&m(M::Verified, Some("A"), vec![], false), ()).is_ok());
        assert!(authorize_release(&m(M::Delivered, Some("A"), vec![], false), ()).is_err());
        assert!(authorize_release(&m(M::Verified, None, vec![], false), ()).is_err());
        let hold = vec![Reason::rule(ReasonCode::CriteriaFailed, "x")];
        assert!(authorize_release(&m(M::Verified, Some("A"), hold.clone(), false), ()).is_err());
        assert!(authorize_release(&m(M::Verified, Some("A"), hold, true), ()).is_ok());
    }

    #[test]
    fn resubmission_rules() {
        let allow = StoredDecision { id: Uuid::nil(), decision: Decision::Allow, hash: "h".into() };
        let needs = StoredDecision { id: Uuid::nil(), decision: Decision::RequireApproval(vec![Reason::rule(ReasonCode::VendorUnknown, "x")]), hash: "h".into() };
        let block = StoredDecision { id: Uuid::nil(), decision: Decision::Block(vec![Reason::rule(ReasonCode::DuplicateInvoice, "x")]), hash: "h".into() };
        let ok = ApprovalInput { verdict: Verdict::Approve, decision_hash: "h" };
        assert!(authorize_resubmission(&allow, None, ()).is_ok());
        assert!(authorize_resubmission(&needs, None, ()).is_err());
        assert!(authorize_resubmission(&needs, Some(&ok), ()).is_ok());
        assert!(authorize_resubmission(&block, Some(&ok), ()).is_err());
    }

}
