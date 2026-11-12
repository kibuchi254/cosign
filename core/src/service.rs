//! Business flows over the database: propose, approve, execute, webhooks, ledger.
//! Every state change writes its audit entry in the same transaction as the change.

use crate::audit;
use crate::executor::{ExecError, ExecOutcome, PayPalExecutor, PaymentInstruction};
use crate::money::{Money, MoneyError};
use crate::paypal::{PayPalClient, WebhookHeaders};
use crate::policy::{
    self, AiFlag, ApprovalInput, Authorized, Context, Decision, Mandate, MandateRules, PaymentRequest, PriorInvoice,
    Reason, StoredDecision, Verdict, VendorRecord,
};
use crate::state::{PaymentEvent, PaymentState};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, Row};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub executor: PayPalExecutor,
    pub paypal: Option<Arc<PayPalClient>>,
    pub agent_token: String,
    pub operator_token: String,
    /// Optional third token for scheduled jobs (/internal/*). The operator token also works.
    pub internal_token: Option<String>,
    pub default_owner: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

impl From<MoneyError> for ServiceError {
    fn from(e: MoneyError) -> Self {
        ServiceError::Invalid(e.to_string())
    }
}

type Result<T> = std::result::Result<T, ServiceError>;

// --- Mandates and vendors -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MandateInput {
    pub owner_id: Option<String>,
    pub rules: MandateRules,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MandateView {
    pub id: Uuid,
    pub owner_id: String,
    pub rules: MandateRules,
    pub hash: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

pub async fn create_mandate(state: &AppState, input: MandateInput) -> Result<MandateView> {
    let owner = input.owner_id.unwrap_or_else(|| state.default_owner.clone());
    let r = &input.rules;
    if r.per_invoice_cap_cents <= 0 || r.daily_cap_cents <= 0 || r.velocity_max_payments == 0 || r.velocity_window_minutes == 0 {
        return Err(ServiceError::Invalid("caps, velocity limit and window must be positive".into()));
    }
    if r.currency.len() != 3 {
        return Err(ServiceError::Invalid("currency must be a three-letter code".into()));
    }
    let mut rules = input.rules.clone();
    rules.currency = rules.currency.to_ascii_uppercase();
    let expires_at = DateTime::from_timestamp(input.expires_at.timestamp(), 0).unwrap_or(input.expires_at);
    let hash = policy::mandate_hash(&owner, &rules, expires_at);
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await?;
    let created_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO mandates (id, owner_id, rules_json, hash, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING created_at",
    )
    .bind(id)
    .bind(&owner)
    .bind(serde_json::to_value(&rules).unwrap())
    .bind(&hash)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await?;
    audit::append(&mut tx, "mandate.created", json!({ "mandate_id": id, "owner_id": owner, "rules": rules, "hash": hash, "expires_at": expires_at.timestamp() })).await?;
    tx.commit().await?;
    Ok(MandateView { id, owner_id: owner, rules, hash, expires_at, created_at })
}

async fn active_mandate(conn: &mut PgConnection, owner: &str) -> Result<Option<(Mandate, DateTime<Utc>)>> {
    let row = sqlx::query("SELECT id, owner_id, rules_json, hash, expires_at, created_at FROM mandates WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1")
        .bind(owner)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(match row {
        None => None,
        Some(r) => {
            let rules: MandateRules = serde_json::from_value(r.get("rules_json")).map_err(|e| ServiceError::Invalid(format!("stored mandate is unreadable: {e}")))?;
            Some((
                Mandate { id: r.get("id"), owner_id: r.get("owner_id"), rules, hash: r.get("hash"), expires_at: r.get("expires_at") },
                r.get("created_at"),
            ))
        }
    })
}

pub async fn get_active_mandate(state: &AppState, owner: Option<String>) -> Result<MandateView> {
    let owner = owner.unwrap_or_else(|| state.default_owner.clone());
    let mut conn = state.pool.acquire().await?;
    let (m, created_at) = active_mandate(&mut conn, &owner).await?.ok_or_else(|| ServiceError::NotFound(format!("no mandate for owner {owner}")))?;
    Ok(MandateView { id: m.id, owner_id: m.owner_id, rules: m.rules, hash: m.hash, expires_at: m.expires_at, created_at })
}

#[derive(Debug, Clone, Deserialize)]
pub struct VendorInput {
    pub name: String,
    pub paypal_email: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VendorView {
    pub id: Uuid,
    pub name: String,
    pub paypal_email: String,
    pub verified_at: DateTime<Utc>,
    pub active: bool,
    pub updated_at: DateTime<Utc>,
    /// Invoices decided for this vendor, and money paid or on its way to them.
    pub invoices: i64,
    pub paid_cents: i64,
    pub last_invoice_at: Option<DateTime<Utc>>,
}

/// A change to an approved vendor. A new payout email is the classic fraud vector, so every
/// change names who made it and why (for example "confirmed by phone with our usual contact").
#[derive(Debug, Clone, Deserialize)]
pub struct VendorUpdate {
    pub name: Option<String>,
    pub paypal_email: Option<String>,
    pub active: Option<bool>,
    pub changed_by: String,
    #[serde(default)]
    pub reason: String,
}

pub async fn create_vendor(state: &AppState, input: VendorInput) -> Result<VendorView> {
    let name = input.name.trim().to_string();
    let email = input.paypal_email.trim().to_lowercase();
    if name.is_empty() || !looks_like_email(&email) {
        return Err(ServiceError::Invalid("vendor needs a name and a valid PayPal email".into()));
    }
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await?;
    let res = sqlx::query("INSERT INTO vendors (id, name, paypal_email, payout_hash) VALUES ($1, $2, $3, $4) RETURNING verified_at")
        .bind(id)
        .bind(&name)
        .bind(&email)
        .bind(policy::payout_hash(&email))
        .fetch_one(&mut *tx)
        .await;
    let verified_at: DateTime<Utc> = match res {
        Ok(r) => r.get("verified_at"),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(ServiceError::Conflict(format!("vendor {name} already exists"))),
        Err(e) => return Err(e.into()),
    };
    // Earlier invoices from this vendor (typically the held one that led to approving it) are
    // linked to the new record, so its history and totals are complete. Only invoices with the
    // same name that asked to be paid at this exact email: anything else stays unlinked.
    let linked = sqlx::query("UPDATE invoices SET vendor_id = $1 WHERE vendor_id IS NULL AND lower(trim(vendor_name)) = lower($2) AND lower(trim(payout_email)) = $3")
        .bind(id)
        .bind(&name)
        .bind(&email)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    audit::append(&mut tx, "vendor.created", json!({ "vendor_id": id, "name": name, "payout_hash": policy::payout_hash(&email), "linked_invoices": linked })).await?;
    tx.commit().await?;
    if linked == 0 {
        return Ok(VendorView { id, name, paypal_email: email, verified_at, active: true, updated_at: verified_at, invoices: 0, paid_cents: 0, last_invoice_at: None });
    }
    let row = sqlx::query(&format!("{VENDOR_SELECT} WHERE v.id = $1 GROUP BY v.id")).bind(id).fetch_one(&state.pool).await?;
    Ok(vendor_view(&row))
}

const VENDOR_SELECT: &str = "SELECT v.id, v.name, v.paypal_email, v.verified_at, v.active, v.updated_at,
        COUNT(i.id) AS invoices,
        COALESCE(SUM(p.amount_cents) FILTER (WHERE p.state IN ('ALLOWED', 'APPROVED', 'SUBMITTED', 'PAID')), 0)::bigint AS paid_cents,
        MAX(i.created_at) AS last_invoice_at
    FROM vendors v
    LEFT JOIN invoices i ON i.vendor_id = v.id
    LEFT JOIN payments p ON p.invoice_id = i.id";

fn vendor_view(r: &sqlx::postgres::PgRow) -> VendorView {
    VendorView {
        id: r.get("id"),
        name: r.get("name"),
        paypal_email: r.get("paypal_email"),
        verified_at: r.get("verified_at"),
        active: r.get("active"),
        updated_at: r.get("updated_at"),
        invoices: r.get("invoices"),
        paid_cents: r.get("paid_cents"),
        last_invoice_at: r.get("last_invoice_at"),
    }
}

pub async fn list_vendors(state: &AppState) -> Result<Vec<VendorView>> {
    let rows = sqlx::query(&format!("{VENDOR_SELECT} GROUP BY v.id ORDER BY v.active DESC, v.name")).fetch_all(&state.pool).await?;
    Ok(rows.iter().map(vendor_view).collect())
}

pub async fn update_vendor(state: &AppState, id: Uuid, input: VendorUpdate) -> Result<VendorView> {
    let changed_by = input.changed_by.trim().to_string();
    let reason = input.reason.trim().to_string();
    if changed_by.is_empty() {
        return Err(ServiceError::Invalid("say who is making this change".into()));
    }
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT name, paypal_email, active FROM vendors WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ServiceError::NotFound(format!("vendor {id}")))?;
    let (old_name, old_email, old_active): (String, String, bool) = (row.get("name"), row.get("paypal_email"), row.get("active"));
    let name = input.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| old_name.clone());
    let email = input.paypal_email.map(|e| e.trim().to_lowercase()).unwrap_or_else(|| old_email.clone());
    let active = input.active.unwrap_or(old_active);
    if !looks_like_email(&email) {
        return Err(ServiceError::Invalid("that is not a valid PayPal email".into()));
    }
    let email_changed = email != old_email;
    if email_changed && reason.len() < 8 {
        return Err(ServiceError::Invalid(
            "a new payout email needs a note on how you verified it (for example: confirmed by phone with our usual contact)".into(),
        ));
    }
    if name == old_name && !email_changed && active == old_active {
        return Err(ServiceError::Invalid("nothing to change".into()));
    }
    let res = sqlx::query("UPDATE vendors SET name = $1, paypal_email = $2, payout_hash = $3, active = $4, updated_at = now() WHERE id = $5")
        .bind(&name)
        .bind(&email)
        .bind(policy::payout_hash(&email))
        .bind(active)
        .bind(id)
        .execute(&mut *tx)
        .await;
    match res {
        Ok(_) => {}
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(ServiceError::Conflict(format!("another vendor is already called {name}"))),
        Err(e) => return Err(e.into()),
    }
    let kind = if active != old_active {
        if active { "vendor.reactivated" } else { "vendor.deactivated" }
    } else if email_changed {
        "vendor.payout_changed"
    } else {
        "vendor.updated"
    };
    audit::append(
        &mut tx,
        kind,
        json!({
            "vendor_id": id,
            "name": name,
            "previous_name": (name != old_name).then_some(&old_name),
            "payout_hash": policy::payout_hash(&email),
            "previous_payout_hash": email_changed.then(|| policy::payout_hash(&old_email)),
            "active": active,
            "changed_by": changed_by,
            "reason": reason,
        }),
    )
    .await?;
    tx.commit().await?;
    let row = sqlx::query(&format!("{VENDOR_SELECT} WHERE v.id = $1 GROUP BY v.id")).bind(id).fetch_one(&state.pool).await?;
    Ok(vendor_view(&row))
}

fn looks_like_email(s: &str) -> bool {
    let mut parts = s.split('@');
    matches!((parts.next(), parts.next(), parts.next()), (Some(l), Some(d), None) if !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.'))
        && !s.chars().any(char::is_whitespace)
}

// --- Proposals ----------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct InvoiceInput {
    pub vendor_name: String,
    pub invoice_number: String,
    pub amount: String,
    pub currency: String,
    pub due_date: Option<String>,
    pub payout_email: String,
    pub source_hash: String,
    #[serde(default)]
    pub extracted: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProposalInput {
    pub owner_id: Option<String>,
    pub invoice: InvoiceInput,
    #[serde(default)]
    pub flags: Vec<AiFlag>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DecisionResponse {
    pub payment_id: Uuid,
    pub invoice_id: Uuid,
    pub decision: String,
    pub reasons: Vec<Reason>,
    pub state: PaymentState,
    pub decision_hash: String,
    pub mandate_id: Uuid,
    pub mandate_hash: String,
    pub payout_ref: Option<String>,
    pub execution: Option<String>,
}

fn reasons_json(d: &Decision) -> Value {
    serde_json::to_value(d.reasons()).unwrap()
}

fn transition(from: PaymentState, event: PaymentEvent) -> Result<PaymentState> {
    from.next(event).map_err(|e| ServiceError::Conflict(e.to_string()))
}

pub async fn propose(state: &AppState, input: ProposalInput) -> Result<DecisionResponse> {
    let owner = input.owner_id.clone().unwrap_or_else(|| state.default_owner.clone());
    let inv = &input.invoice;
    let amount = Money::parse(&inv.amount, &inv.currency)?;
    let payout_email = inv.payout_email.trim().to_lowercase();
    if !looks_like_email(&payout_email) {
        return Err(ServiceError::Invalid(format!("payout email {:?} is not a valid email", inv.payout_email)));
    }
    if inv.vendor_name.trim().is_empty() || inv.invoice_number.trim().is_empty() || inv.source_hash.trim().is_empty() {
        return Err(ServiceError::Invalid("vendor_name, invoice_number and source_hash are required".into()));
    }
    // An unparseable due date is treated as missing, which the rules escalate.
    let due_date = inv.due_date.as_deref().and_then(|d| NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d").ok());
    let req = PaymentRequest {
        vendor_name: inv.vendor_name.trim().to_string(),
        invoice_number: inv.invoice_number.trim().to_string(),
        amount: amount.clone(),
        due_date,
        payout_email: payout_email.clone(),
        ai_flags: input.flags.clone(),
    };

    let now = Utc::now();
    let mut tx = state.pool.begin().await?;
    // One decision at a time per owner, so caps, velocity and duplicates see every earlier decision.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('cosign-owner:' || $1))").bind(&owner).execute(&mut *tx).await?;

    let (mandate, _) = active_mandate(&mut tx, &owner).await?.ok_or_else(|| ServiceError::Conflict(format!("owner {owner} has no mandate")))?;
    // Deactivated vendors stay in the list so their payout record is still enforced; the policy
    // holds any invoice from one for a signature.
    let vendors: Vec<VendorRecord> = sqlx::query("SELECT id, name, payout_hash, active FROM vendors")
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r| VendorRecord { id: r.get("id"), name: r.get("name"), payout_hash: r.get("payout_hash"), active: r.get("active") })
        .collect();
    let prior: Vec<PriorInvoice> = sqlx::query("SELECT vendor_id, vendor_name, number, amount_cents, currency FROM invoices WHERE created_at > now() - interval '400 days'")
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r| PriorInvoice {
            vendor_id: r.get("vendor_id"),
            vendor_name: r.get("vendor_name"),
            number: r.get("number"),
            amount: Money { cents: r.get("amount_cents"), currency: r.get::<String, _>("currency") },
        })
        .collect();
    const COMMITTED: &str = "('ALLOWED', 'APPROVED', 'SUBMITTED', 'PAID')";
    let day_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
    let committed_today: i64 = sqlx::query_scalar(&format!(
        "SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM payments p JOIN mandates m ON m.id = p.mandate_id
         WHERE m.owner_id = $1 AND p.currency = $2 AND p.state IN {COMMITTED} AND p.created_at >= $3"
    ))
    .bind(&owner)
    .bind(&mandate.rules.currency)
    .bind(day_start)
    .fetch_one(&mut *tx)
    .await?;
    let window_start = now - Duration::minutes(i64::from(mandate.rules.velocity_window_minutes));
    let in_window: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM payments p JOIN mandates m ON m.id = p.mandate_id
         WHERE m.owner_id = $1 AND p.state IN {COMMITTED} AND p.created_at >= $2"
    ))
    .bind(&owner)
    .bind(window_start)
    .fetch_one(&mut *tx)
    .await?;

    let ctx = Context {
        now,
        mandate: &mandate,
        vendors: &vendors,
        prior_invoices: &prior,
        committed_today_cents: committed_today,
        payments_in_velocity_window: u32::try_from(in_window).unwrap_or(u32::MAX),
    };
    let evaluation = policy::evaluate(&req, &ctx);
    let decision = evaluation.decision.clone();

    let invoice_id = Uuid::new_v4();
    let payment_id = Uuid::new_v4();
    let idempotency_key = Uuid::new_v4();
    let decision_hash = policy::decision_hash(payment_id, &decision, &mandate.hash, &inv.source_hash, &amount, &payout_email);
    let event = match decision {
        Decision::Allow => PaymentEvent::DecidedAllow,
        Decision::RequireApproval(_) => PaymentEvent::DecidedRequireApproval,
        Decision::Block(_) => PaymentEvent::DecidedBlock,
    };
    let mut current = transition(PaymentState::Proposed, event)?;

    sqlx::query(
        "INSERT INTO invoices (id, vendor_id, vendor_name, number, amount_cents, currency, due_date, payout_email, source_hash, extracted_json, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(invoice_id)
    .bind(evaluation.vendor_id)
    .bind(&req.vendor_name)
    .bind(&req.invoice_number)
    .bind(amount.cents)
    .bind(&amount.currency)
    .bind(due_date)
    .bind(&payout_email)
    .bind(inv.source_hash.trim())
    .bind(&inv.extracted)
    .bind(serde_json::to_value(&input.flags).unwrap())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO payments (id, invoice_id, mandate_id, amount_cents, currency, receiver_email, decision, reasons, decision_hash, state, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(payment_id)
    .bind(invoice_id)
    .bind(mandate.id)
    .bind(amount.cents)
    .bind(&amount.currency)
    .bind(&payout_email)
    .bind(decision.outcome_str())
    .bind(reasons_json(&decision))
    .bind(&decision_hash)
    .bind(current.as_str())
    .bind(idempotency_key)
    .execute(&mut *tx)
    .await?;
    audit::append(
        &mut tx,
        "payment.decided",
        json!({
            "payment_id": payment_id,
            "invoice_id": invoice_id,
            "vendor_name": req.vendor_name,
            "invoice_number": req.invoice_number,
            "amount": amount,
            "payout_email": payout_email,
            "source_hash": inv.source_hash.trim(),
            "outcome": decision.outcome_str(),
            "reasons": reasons_json(&decision),
            "agent_flags": input.flags,
            "mandate_id": mandate.id,
            "mandate_hash": mandate.hash,
            "decision_hash": decision_hash,
            "state": current,
        }),
    )
    .await?;

    // Authorize from the fresh evaluation and mark the payment submitted before PayPal is called.
    let authorized = match policy::authorize_allowed(
        &evaluation,
        payment_id,
        PaymentInstruction {
            payment_id,
            amount: amount.clone(),
            receiver_email: payout_email.clone(),
            note: format!("{} invoice {}", req.vendor_name, req.invoice_number),
            idempotency_key,
        },
    ) {
        Ok(a) => {
            current = mark_submitted(&mut tx, payment_id, current).await?;
            Some(a)
        }
        Err(_) => None,
    };
    tx.commit().await?;

    let (payout_ref, execution) = match authorized {
        Some(a) => {
            let (s, r, msg) = execute(state, payment_id, a).await?;
            current = s;
            (r, Some(msg))
        }
        None => (None, None),
    };

    Ok(DecisionResponse {
        payment_id,
        invoice_id,
        decision: decision.outcome_str().into(),
        reasons: decision.reasons().to_vec(),
        state: current,
        decision_hash,
        mandate_id: mandate.id,
        mandate_hash: mandate.hash,
        payout_ref,
        execution,
    })
}

async fn mark_submitted(conn: &mut PgConnection, payment_id: Uuid, from: PaymentState) -> Result<PaymentState> {
    let to = transition(from, PaymentEvent::Submit)?;
    sqlx::query("UPDATE payments SET state = $1, updated_at = now() WHERE id = $2").bind(to.as_str()).bind(payment_id).execute(&mut *conn).await?;
    audit::append(conn, "payment.submitted", json!({ "payment_id": payment_id, "from": from, "to": to })).await?;
    Ok(to)
}

/// Calls the executor, then records what happened in its own transaction.
async fn execute(state: &AppState, payment_id: Uuid, auth: Authorized<PaymentInstruction>) -> Result<(PaymentState, Option<String>, String)> {
    let outcome = state.executor.pay(auth).await;
    let mut tx = state.pool.begin().await?;
    let result = match outcome {
        Ok(ExecOutcome::Submitted { payout_ref, batch_status }) => {
            sqlx::query("UPDATE payments SET paypal_payout_ref = $1, updated_at = now() WHERE id = $2").bind(&payout_ref).bind(payment_id).execute(&mut *tx).await?;
            audit::append(&mut tx, "payment.payout_accepted", json!({ "payment_id": payment_id, "payout_ref": payout_ref, "batch_status": batch_status })).await?;
            (PaymentState::Submitted, Some(payout_ref), format!("PayPal accepted the payout ({batch_status}); awaiting webhook"))
        }
        Ok(ExecOutcome::Simulated { payout_ref }) => {
            let to = transition(PaymentState::Submitted, PaymentEvent::ConfirmPaid)?;
            sqlx::query("UPDATE payments SET state = $1, paypal_payout_ref = $2, updated_at = now() WHERE id = $3")
                .bind(to.as_str())
                .bind(&payout_ref)
                .bind(payment_id)
                .execute(&mut *tx)
                .await?;
            audit::append(&mut tx, "payment.paid", json!({ "payment_id": payment_id, "payout_ref": payout_ref, "simulated": true })).await?;
            (to, Some(payout_ref), "simulated payout (no PayPal credentials configured)".to_string())
        }
        Err(ExecError::Rejected(msg)) => {
            let to = transition(PaymentState::Submitted, PaymentEvent::Fail)?;
            sqlx::query("UPDATE payments SET state = $1, failure = $2, updated_at = now() WHERE id = $3").bind(to.as_str()).bind(&msg).bind(payment_id).execute(&mut *tx).await?;
            audit::append(&mut tx, "payment.failed", json!({ "payment_id": payment_id, "error": msg })).await?;
            (to, None, format!("PayPal rejected the payout: {msg}"))
        }
        Err(ExecError::Unknown(msg)) => {
            sqlx::query("UPDATE payments SET failure = $1, updated_at = now() WHERE id = $2").bind(&msg).bind(payment_id).execute(&mut *tx).await?;
            audit::append(&mut tx, "payment.outcome_unknown", json!({ "payment_id": payment_id, "error": msg })).await?;
            (PaymentState::Submitted, None, format!("outcome unknown, left SUBMITTED: {msg}"))
        }
    };
    tx.commit().await?;
    Ok(result)
}

// --- Approvals ------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ApprovalBody {
    pub verdict: Verdict,
    pub approver: String,
    pub decision_hash: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalResponse {
    pub payment_id: Uuid,
    pub approval_id: Uuid,
    pub verdict: Verdict,
    pub state: PaymentState,
    pub payout_ref: Option<String>,
    pub execution: Option<String>,
}

pub async fn approve(state: &AppState, payment_id: Uuid, body: ApprovalBody) -> Result<ApprovalResponse> {
    if body.approver.trim().is_empty() {
        return Err(ServiceError::Invalid("approver is required".into()));
    }
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT decision, reasons, decision_hash, state, amount_cents, currency, receiver_email, idempotency_key, invoice_id FROM payments WHERE id = $1 FOR UPDATE")
        .bind(payment_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ServiceError::NotFound(format!("payment {payment_id} not found")))?;
    let current = PaymentState::parse(row.get::<String, _>("state").as_str()).ok_or_else(|| ServiceError::Conflict("payment has an unknown state".into()))?;
    let reasons: Vec<Reason> = serde_json::from_value(row.get("reasons")).map_err(|e| ServiceError::Conflict(format!("stored reasons unreadable: {e}")))?;
    let decision = Decision::from_stored(row.get::<String, _>("decision").as_str(), reasons).ok_or_else(|| ServiceError::Conflict("stored decision unreadable".into()))?;
    let stored = StoredDecision { id: payment_id, decision, hash: row.get("decision_hash") };
    if current != PaymentState::NeedsApproval {
        return Err(ServiceError::Conflict(format!("payment is {}, not awaiting approval", current.as_str())));
    }
    let amount = Money { cents: row.get("amount_cents"), currency: row.get("currency") };
    let receiver: String = row.get("receiver_email");
    let instruction = PaymentInstruction {
        payment_id,
        amount,
        receiver_email: receiver,
        note: "Cosign approved payment".into(),
        idempotency_key: row.get("idempotency_key"),
    };
    let auth = policy::authorize_approved(&stored, &ApprovalInput { verdict: body.verdict, decision_hash: &body.decision_hash }, instruction);
    let auth = match (auth, body.verdict) {
        (Ok(a), _) => Some(a),
        (Err(policy::AuthError::Denied), Verdict::Deny) => None,
        (Err(e), _) => return Err(ServiceError::Conflict(e.to_string())),
    };

    let approval_id = Uuid::new_v4();
    sqlx::query("INSERT INTO approvals (id, subject_id, decision_hash, approver, verdict, note) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(approval_id)
        .bind(payment_id)
        .bind(&stored.hash)
        .bind(body.approver.trim())
        .bind(if body.verdict == Verdict::Approve { "approve" } else { "deny" })
        .bind(&body.note)
        .execute(&mut *tx)
        .await?;
    let event = if body.verdict == Verdict::Approve { PaymentEvent::Approve } else { PaymentEvent::Deny };
    let mut next = transition(current, event)?;
    sqlx::query("UPDATE payments SET state = $1, updated_at = now() WHERE id = $2").bind(next.as_str()).bind(payment_id).execute(&mut *tx).await?;
    audit::append(
        &mut tx,
        "approval.recorded",
        json!({ "approval_id": approval_id, "payment_id": payment_id, "decision_hash": stored.hash, "approver": body.approver.trim(), "verdict": body.verdict, "note": body.note, "state": next }),
    )
    .await?;
    if auth.is_some() {
        next = mark_submitted(&mut tx, payment_id, next).await?;
    }
    tx.commit().await?;

    let (payout_ref, execution) = match auth {
        Some(a) => {
            let (s, r, msg) = execute(state, payment_id, a).await?;
            next = s;
            (r, Some(msg))
        }
        None => (None, None),
    };
    Ok(ApprovalResponse { payment_id, approval_id, verdict: body.verdict, state: next, payout_ref, execution })
}

// --- Webhooks -------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WebhookResult {
    pub event_id: String,
    pub event_type: String,
    pub duplicate: bool,
    pub applied: Option<String>,
}

pub async fn handle_webhook(state: &AppState, headers: &axum::http::HeaderMap, raw_body: &str) -> Result<WebhookResult> {
    let client = state.paypal.as_ref().ok_or_else(|| ServiceError::Unavailable("webhooks need PayPal credentials; core is in simulation mode".into()))?;
    let h = WebhookHeaders::from_http(headers).ok_or_else(|| ServiceError::Unauthorized("missing PayPal signature headers".into()))?;
    let verified = client.verify_webhook(&h, raw_body).await.map_err(|e| ServiceError::Unavailable(format!("could not verify webhook: {e}")))?;
    if !verified {
        return Err(ServiceError::Unauthorized("webhook signature did not verify".into()));
    }
    let event: Value = serde_json::from_str(raw_body).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    apply_verified_event(state, &event).await
}

/// Applies an event already verified by PayPal. Split out so tests can drive it directly.
pub async fn apply_verified_event(state: &AppState, event: &Value) -> Result<WebhookResult> {
    let event_id = event.get("id").and_then(Value::as_str).ok_or_else(|| ServiceError::Invalid("event has no id".into()))?.to_string();
    let event_type = event.get("event_type").and_then(Value::as_str).unwrap_or("UNKNOWN").to_string();
    let mut tx = state.pool.begin().await?;
    let inserted = sqlx::query("INSERT INTO webhook_events (event_id, event_type, verified, payload_json) VALUES ($1, $2, true, $3) ON CONFLICT (event_id) DO NOTHING")
        .bind(&event_id)
        .bind(&event_type)
        .bind(event)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if inserted == 0 {
        tx.rollback().await?;
        return Ok(WebhookResult { event_id, event_type, duplicate: true, applied: None });
    }

    let resource = event.get("resource").cloned().unwrap_or(Value::Null);
    let mut applied = None;
    if let Some(suffix) = event_type.strip_prefix("PAYMENT.PAYOUTS-ITEM.") {
        let payment_id = resource.pointer("/payout_item/sender_item_id").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
        let item_id = resource.get("payout_item_id").and_then(Value::as_str).map(str::to_string);
        let event_kind = match suffix {
            "SUCCEEDED" => Some(PaymentEvent::ConfirmPaid),
            "FAILED" | "RETURNED" | "BLOCKED" | "DENIED" | "CANCELED" | "REFUNDED" => Some(PaymentEvent::Fail),
            _ => None, // UNCLAIMED, HELD: still in flight
        };
        if let Some(pid) = payment_id {
            let row = sqlx::query("SELECT state FROM payments WHERE id = $1 FOR UPDATE").bind(pid).fetch_optional(&mut *tx).await?;
            if let Some(row) = row {
                let current = PaymentState::parse(row.get::<String, _>("state").as_str());
                let next = match (current, event_kind) {
                    (Some(c), Some(e)) => c.next(e).ok(),
                    _ => None,
                };
                if let Some(to) = next {
                    sqlx::query("UPDATE payments SET state = $1, paypal_item_id = COALESCE($2, paypal_item_id), failure = CASE WHEN $1 = 'FAILED' THEN $3 ELSE failure END, updated_at = now() WHERE id = $4")
                        .bind(to.as_str())
                        .bind(&item_id)
                        .bind(&event_type)
                        .bind(pid)
                        .execute(&mut *tx)
                        .await?;
                    applied = Some(format!("payment {pid} -> {}", to.as_str()));
                } else {
                    applied = Some(format!("payment {pid} unchanged ({})", current.map(PaymentState::as_str).unwrap_or("?")));
                }
            }
        }
    }
    audit::append(&mut tx, "webhook.received", json!({ "event_id": event_id, "event_type": event_type, "applied": applied })).await?;
    tx.commit().await?;
    Ok(WebhookResult { event_id, event_type, duplicate: false, applied })
}

/// Asks PayPal for the status of every payout still in flight and applies it like a webhook.
/// Webhooks need a public URL; a local demo or a missed delivery has neither, so the core also
/// polls. Each (item, status) pair is recorded once, so polling never repeats an audit entry.
pub async fn reconcile_payouts(state: &AppState) -> Result<Vec<WebhookResult>> {
    let Some(client) = state.paypal.as_ref() else { return Ok(vec![]) };
    let rows = sqlx::query("SELECT DISTINCT paypal_payout_ref FROM payments WHERE state = 'SUBMITTED' AND paypal_payout_ref IS NOT NULL LIMIT 50")
        .fetch_all(&state.pool)
        .await?;
    let mut out = Vec::new();
    for row in rows {
        let batch: String = row.get("paypal_payout_ref");
        let v = match client.get_payout(&batch).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(%batch, error = %e, "could not read payout status");
                continue;
            }
        };
        for item in v.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
            let (Some(item_id), Some(status)) = (item.get("payout_item_id").and_then(Value::as_str), item.get("transaction_status").and_then(Value::as_str)) else { continue };
            let suffix = match status {
                "SUCCESS" => "SUCCEEDED",
                "ONHOLD" => "HELD",
                "PENDING" | "NEW" => continue,
                s => s,
            };
            let event = json!({
                "id": format!("poll-{item_id}-{status}"),
                "event_type": format!("PAYMENT.PAYOUTS-ITEM.{suffix}"),
                "source": "status poll (GET /v1/payments/payouts)",
                "resource": item,
            });
            let r = apply_verified_event(state, &event).await?;
            if !r.duplicate {
                tracing::info!(%batch, %item_id, %status, applied = ?r.applied, "payout status from PayPal");
                out.push(r);
            }
        }
    }
    Ok(out)
}

// --- Ledger ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct LedgerPayment {
    pub payment_id: Uuid,
    pub invoice_id: Uuid,
    pub vendor_name: String,
    /// The vendor record this invoice matched by name (active or deactivated), if any.
    pub vendor_id: Option<Uuid>,
    pub vendor_known: bool,
    pub invoice_number: String,
    pub amount: String,
    pub amount_cents: i64,
    pub currency: String,
    pub due_date: Option<NaiveDate>,
    pub receiver_email: String,
    pub decision: String,
    pub reasons: Value,
    pub agent_flags: Value,
    pub state: String,
    pub decision_hash: String,
    pub mandate_hash: String,
    pub payout_ref: Option<String>,
    pub failure: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Ledger {
    pub as_of: DateTime<Utc>,
    pub simulation: bool,
    pub mandate: Option<MandateView>,
    pub totals: Value,
    pub payments: Vec<LedgerPayment>,
    pub audit: audit::VerifyReport,
}

pub async fn ledger(state: &AppState, owner: Option<String>) -> Result<Ledger> {
    let owner = owner.unwrap_or_else(|| state.default_owner.clone());
    let mandate = get_active_mandate(state, Some(owner.clone())).await.ok();
    let rows = sqlx::query(
        "SELECT p.id, p.invoice_id, i.vendor_name, i.vendor_id, i.number, p.amount_cents, p.currency, i.due_date, p.receiver_email,
                p.decision, p.reasons, i.flags, p.state, p.decision_hash, m.hash AS mandate_hash, p.paypal_payout_ref, p.failure,
                p.created_at, p.updated_at
         FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN mandates m ON m.id = p.mandate_id
         WHERE m.owner_id = $1 ORDER BY p.created_at DESC LIMIT 500",
    )
    .bind(&owner)
    .fetch_all(&state.pool)
    .await?;
    let payments: Vec<LedgerPayment> = rows
        .into_iter()
        .map(|r| {
            let cents: i64 = r.get("amount_cents");
            let currency: String = r.get("currency");
            LedgerPayment {
                payment_id: r.get("id"),
                invoice_id: r.get("invoice_id"),
                vendor_name: r.get("vendor_name"),
                vendor_id: r.get("vendor_id"),
                vendor_known: r.get::<Option<Uuid>, _>("vendor_id").is_some(),
                invoice_number: r.get("number"),
                amount: Money { cents, currency: currency.clone() }.to_paypal_value(),
                amount_cents: cents,
                currency,
                due_date: r.get("due_date"),
                receiver_email: r.get("receiver_email"),
                decision: r.get("decision"),
                reasons: r.get("reasons"),
                agent_flags: r.get("flags"),
                state: r.get("state"),
                decision_hash: r.get("decision_hash"),
                mandate_hash: r.get("mandate_hash"),
                payout_ref: r.get("paypal_payout_ref"),
                failure: r.get("failure"),
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
            }
        })
        .collect();
    let sum = |pred: &dyn Fn(&LedgerPayment) -> bool| payments.iter().filter(|p| pred(p)).map(|p| p.amount_cents).sum::<i64>();
    let count = |s: &str| payments.iter().filter(|p| p.state == s).count();
    let totals = json!({
        "paid_cents": sum(&|p| p.state == "PAID"),
        "in_flight_cents": sum(&|p| p.state == "SUBMITTED"),
        "awaiting_approval_cents": sum(&|p| p.state == "NEEDS_APPROVAL"),
        "blocked_cents": sum(&|p| p.state == "BLOCKED"),
        "counts": {
            "paid": count("PAID"), "submitted": count("SUBMITTED"), "needs_approval": count("NEEDS_APPROVAL"),
            "blocked": count("BLOCKED"), "denied": count("DENIED"), "failed": count("FAILED"),
        }
    });
    Ok(Ledger { as_of: Utc::now(), simulation: !state.executor.is_live(), mandate, totals, payments, audit: audit::verify(&state.pool).await? })
}

pub async fn recent_audit(state: &AppState, limit: i64) -> Result<Vec<audit::AuditEntry>> {
    let mut all = audit::load_all(&state.pool).await?;
    let keep = usize::try_from(limit.clamp(1, 1000)).unwrap();
    let start = all.len().saturating_sub(keep);
    Ok(all.split_off(start))
}

// --- Retry after an unknown outcome -------------------------------------------------------------

/// Re-sends a payment left SUBMITTED after an unknown outcome, with its original
/// idempotency key, so PayPal pays at most once.
pub async fn retry_payment(state: &AppState, payment_id: Uuid) -> Result<DecisionResponse> {
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        "SELECT p.decision, p.reasons, p.decision_hash, p.state, p.amount_cents, p.currency, p.receiver_email, p.idempotency_key, p.invoice_id,
                p.mandate_id, p.paypal_payout_ref, p.failure, m.hash AS mandate_hash, i.vendor_name, i.number
         FROM payments p JOIN mandates m ON m.id = p.mandate_id JOIN invoices i ON i.id = p.invoice_id WHERE p.id = $1 FOR UPDATE OF p",
    )
    .bind(payment_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ServiceError::NotFound(format!("payment {payment_id} not found")))?;
    let current = PaymentState::parse(row.get::<String, _>("state").as_str()).ok_or_else(|| ServiceError::Conflict("unknown state".into()))?;
    if current != PaymentState::Submitted || row.get::<Option<String>, _>("paypal_payout_ref").is_some() || row.get::<Option<String>, _>("failure").is_none() {
        return Err(ServiceError::Conflict("only a SUBMITTED payment whose outcome is unknown can be retried".into()));
    }
    let reasons: Vec<Reason> = serde_json::from_value(row.get("reasons")).unwrap_or_default();
    let decision = Decision::from_stored(row.get::<String, _>("decision").as_str(), reasons).ok_or_else(|| ServiceError::Conflict("stored decision unreadable".into()))?;
    let hash: String = row.get("decision_hash");
    let stored = StoredDecision { id: payment_id, decision: decision.clone(), hash: hash.clone() };
    let approved: Option<String> = sqlx::query_scalar("SELECT decision_hash FROM approvals WHERE subject_id = $1 AND verdict = 'approve' AND decision_hash = $2")
        .bind(payment_id)
        .bind(&hash)
        .fetch_optional(&mut *tx)
        .await?;
    let approval = approved.as_deref().map(|h| ApprovalInput { verdict: Verdict::Approve, decision_hash: h });
    let instruction = PaymentInstruction {
        payment_id,
        amount: Money { cents: row.get("amount_cents"), currency: row.get("currency") },
        receiver_email: row.get("receiver_email"),
        note: format!("{} invoice {}", row.get::<String, _>("vendor_name"), row.get::<String, _>("number")),
        idempotency_key: row.get("idempotency_key"),
    };
    let auth = policy::authorize_resubmission(&stored, approval.as_ref(), instruction).map_err(|e| ServiceError::Conflict(e.to_string()))?;
    audit::append(&mut tx, "payment.retried", json!({ "payment_id": payment_id })).await?;
    tx.commit().await?;
    let (state_after, payout_ref, msg) = execute(state, payment_id, auth).await?;
    Ok(DecisionResponse {
        payment_id,
        invoice_id: row.get("invoice_id"),
        decision: decision.outcome_str().into(),
        reasons: decision.reasons().to_vec(),
        state: state_after,
        decision_hash: hash,
        mandate_id: row.get("mandate_id"),
        mandate_hash: row.get("mandate_hash"),
        payout_ref,
        execution: Some(msg),
    })
}

/// A PayPal access token for the agent's read-only MCP server. The client secret never
/// leaves the core. Off unless COSIGN_SHARE_READ_TOKEN=1, because PayPal tokens are not
/// scoped down: the token can do whatever the REST app can (see docs/SECURITY.md).
pub async fn agent_read_token(state: &AppState) -> Result<Value> {
    if std::env::var("COSIGN_SHARE_READ_TOKEN").as_deref() != Ok("1") {
        return Err(ServiceError::Unavailable("token sharing is off (set COSIGN_SHARE_READ_TOKEN=1)".into()));
    }
    let client = state.executor.live_client().ok_or_else(|| ServiceError::Unavailable("simulation mode: no PayPal token".into()))?;
    let token = client.access_token().await.map_err(|e| ServiceError::Unavailable(e.to_string()))?;
    let mut conn = state.pool.acquire().await?;
    audit::append(&mut conn, "agent.read_token_issued", json!({ "at": Utc::now().timestamp() })).await?;
    Ok(json!({ "access_token": token, "environment": if client.config().base_url.contains("sandbox") { "SANDBOX" } else { "PRODUCTION" } }))
}
