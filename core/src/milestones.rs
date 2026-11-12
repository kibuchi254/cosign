//! Milestone escrow over PayPal authorizations.
//!
//!   Draft --fund--> Funded --deliver--> Delivered --criteria pass--> Verified --release--> Released
//!                     ^                     |  criteria fail: held for the buyer
//!                     +------reject---------+  (accept -> Verified, reject -> Funded)
//!   Funded, Delivered and Verified can also be voided, or expire if the hold lapses.
//!
//! Order matters: milestone N can be funded only once N-1 is funded, and delivered only once
//! N-1 is released (or voided), so an unpaid milestone visibly blocks the next phase.

use crate::audit;
use crate::executor::{ExecError, FundOutcome, ReleaseInstruction};
use crate::money::Money;
use crate::policy::{self, AiFlag, CriterionResult, Decision, Reason, StoredMilestone};
use crate::service::{AppState, ServiceError};
use crate::state::{MilestoneEvent, MilestoneState};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, Row, postgres::PgRow};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ServiceError>;

/// PayPal honors an authorization for 3 days; after that it can be reauthorized once.
pub const HONOR_PERIOD: Duration = Duration::days(3);
/// An authorization lives 29 days in total.
pub const AUTHORIZATION_LIFETIME: Duration = Duration::days(29);

// --- Views and inputs ----------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct MilestoneInput {
    pub title: String,
    pub amount: String,
    pub currency: String,
    #[serde(default)]
    pub criteria: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DealInput {
    pub owner_id: Option<String>,
    pub title: String,
    pub seller: String,
    pub seller_email: String,
    pub milestones: Vec<MilestoneInput>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MilestoneView {
    pub id: Uuid,
    pub deal_id: Uuid,
    pub seq: i32,
    pub title: String,
    pub amount: String,
    pub amount_cents: i64,
    pub currency: String,
    pub criteria: Vec<String>,
    pub state: MilestoneState,
    pub paypal_order_id: Option<String>,
    pub approve_url: Option<String>,
    pub authorization_id: Option<String>,
    pub authorized_at: Option<DateTime<Utc>>,
    pub auth_expires_at: Option<DateTime<Utc>>,
    pub reauthorized_count: i32,
    pub evidence: Option<Value>,
    pub evidence_hash: Option<String>,
    pub criteria_result: Option<Value>,
    pub hold_reasons: Vec<Reason>,
    pub buyer_accepted_hold: bool,
    pub capture_id: Option<String>,
    pub payout_ref: Option<String>,
    pub failure: Option<String>,
    /// Why the next step cannot happen yet, if anything blocks it.
    pub blocked_by: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DealView {
    pub id: Uuid,
    pub owner_id: String,
    pub title: String,
    pub buyer: String,
    pub seller: String,
    pub seller_email: String,
    pub created_at: DateTime<Utc>,
    pub total_cents: i64,
    pub held_cents: i64,
    pub released_cents: i64,
    pub milestones: Vec<MilestoneView>,
}

const MILESTONE_COLS: &str = "id, deal_id, seq, title, amount_cents, currency, criteria_json, state, paypal_order_id, approve_url, authorization_id, \
     authorized_at, auth_expires_at, reauthorized_count, evidence_json, evidence_hash, criteria_result_json, hold_reasons, buyer_accepted_hold, \
     capture_id, payout_ref, failure, release_idempotency_key, updated_at";

fn parse_state(s: &str) -> Result<MilestoneState> {
    MilestoneState::ALL
        .into_iter()
        .find(|m| serde_json::to_value(m).ok().and_then(|v| v.as_str().map(|x| x == s)).unwrap_or(false))
        .ok_or_else(|| ServiceError::Conflict(format!("unknown milestone state {s}")))
}

fn state_str(s: MilestoneState) -> String {
    serde_json::to_value(s).unwrap().as_str().unwrap().to_string()
}

fn row_to_view(r: &PgRow) -> Result<MilestoneView> {
    let cents: i64 = r.get("amount_cents");
    let currency: String = r.get("currency");
    let holds: Option<Value> = r.get("hold_reasons");
    Ok(MilestoneView {
        id: r.get("id"),
        deal_id: r.get("deal_id"),
        seq: r.get("seq"),
        title: r.get("title"),
        amount: Money { cents, currency: currency.clone() }.to_paypal_value(),
        amount_cents: cents,
        currency,
        criteria: serde_json::from_value(r.get("criteria_json")).unwrap_or_default(),
        state: parse_state(r.get::<String, _>("state").as_str())?,
        paypal_order_id: r.get("paypal_order_id"),
        approve_url: r.get("approve_url"),
        authorization_id: r.get("authorization_id"),
        authorized_at: r.get("authorized_at"),
        auth_expires_at: r.get("auth_expires_at"),
        reauthorized_count: r.get("reauthorized_count"),
        evidence: r.get("evidence_json"),
        evidence_hash: r.get("evidence_hash"),
        criteria_result: r.get("criteria_result_json"),
        hold_reasons: holds.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        buyer_accepted_hold: r.get("buyer_accepted_hold"),
        capture_id: r.get("capture_id"),
        payout_ref: r.get("payout_ref"),
        failure: r.get("failure"),
        blocked_by: None,
        updated_at: r.get("updated_at"),
    })
}

/// Fills in `blocked_by` from the order rules.
fn annotate(ms: &mut [MilestoneView]) {
    ms.sort_by_key(|m| m.seq);
    for i in 0..ms.len() {
        let prev = if i == 0 { None } else { Some((ms[i - 1].seq, ms[i - 1].state)) };
        let m = &ms[i];
        let blocked = match (m.state, prev) {
            (MilestoneState::Draft, Some((seq, MilestoneState::Draft))) => Some(format!("milestone {seq} is not funded yet")),
            (MilestoneState::Funded, Some((seq, s))) if !is_closed(s) => Some(format!("milestone {seq} must be released before work here is delivered")),
            (MilestoneState::Delivered, _) if !m.hold_reasons.is_empty() && !m.buyer_accepted_hold => Some("held: the buyer must accept or reject the delivery".into()),
            _ => None,
        };
        ms[i].blocked_by = blocked;
    }
}

fn is_closed(s: MilestoneState) -> bool {
    matches!(s, MilestoneState::Released | MilestoneState::Voided | MilestoneState::Expired)
}

fn funded_or_later(s: MilestoneState) -> bool {
    !matches!(s, MilestoneState::Draft)
}

// --- Deals --------------------------------------------------------------------------------

pub async fn create_deal(state: &AppState, input: DealInput) -> Result<DealView> {
    let owner = input.owner_id.clone().unwrap_or_else(|| state.default_owner.clone());
    let seller_email = input.seller_email.trim().to_lowercase();
    if input.title.trim().is_empty() || input.seller.trim().is_empty() || !seller_email.contains('@') {
        return Err(ServiceError::Invalid("a deal needs a title, a seller and a seller PayPal email".into()));
    }
    if input.milestones.is_empty() || input.milestones.len() > 20 {
        return Err(ServiceError::Invalid("a deal needs 1 to 20 milestones".into()));
    }
    let mut parsed = Vec::new();
    for m in &input.milestones {
        let amount = Money::parse(&m.amount, &m.currency)?;
        let criteria: Vec<String> = m.criteria.iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
        if m.title.trim().is_empty() || criteria.is_empty() {
            return Err(ServiceError::Invalid("each milestone needs a title and at least one acceptance criterion".into()));
        }
        parsed.push((m.title.trim().to_string(), amount, criteria));
    }
    let deal_id = Uuid::new_v4();
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO deals (id, title, buyer, seller, owner_id, seller_email) VALUES ($1, $2, $3, $4, $3, $5)")
        .bind(deal_id)
        .bind(input.title.trim())
        .bind(&owner)
        .bind(input.seller.trim())
        .bind(&seller_email)
        .execute(&mut *tx)
        .await?;
    for (i, (title, amount, criteria)) in parsed.iter().enumerate() {
        sqlx::query("INSERT INTO milestones (id, deal_id, seq, title, amount_cents, currency, criteria_json, state) VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT')")
            .bind(Uuid::new_v4())
            .bind(deal_id)
            .bind(i as i32 + 1)
            .bind(title)
            .bind(amount.cents)
            .bind(&amount.currency)
            .bind(json!(criteria))
            .execute(&mut *tx)
            .await?;
    }
    audit::append(
        &mut tx,
        "deal.created",
        json!({ "deal_id": deal_id, "owner_id": owner, "title": input.title.trim(), "seller": input.seller.trim(), "seller_email": seller_email,
                "milestones": parsed.iter().map(|(t, a, c)| json!({ "title": t, "amount": a, "criteria": c })).collect::<Vec<_>>() }),
    )
    .await?;
    tx.commit().await?;
    get_deal(state, deal_id).await
}

pub async fn get_deal(state: &AppState, deal_id: Uuid) -> Result<DealView> {
    list_deals_where(state, "WHERE d.id = $1", Some(deal_id), None).await?.pop().ok_or_else(|| ServiceError::NotFound(format!("deal {deal_id} not found")))
}

pub async fn list_deals(state: &AppState, owner: Option<String>) -> Result<Vec<DealView>> {
    let owner = owner.unwrap_or_else(|| state.default_owner.clone());
    list_deals_where(state, "WHERE d.owner_id = $2", None, Some(owner)).await
}

async fn list_deals_where(state: &AppState, filter: &str, id: Option<Uuid>, owner: Option<String>) -> Result<Vec<DealView>> {
    let deals = sqlx::query(&format!("SELECT d.id, d.owner_id, d.title, d.buyer, d.seller, d.seller_email, d.created_at FROM deals d {filter} ORDER BY d.created_at DESC"))
        .bind(id)
        .bind(owner)
        .fetch_all(&state.pool)
        .await?;
    let mut out = Vec::new();
    for d in deals {
        let deal_id: Uuid = d.get("id");
        let rows = sqlx::query(&format!("SELECT {MILESTONE_COLS} FROM milestones WHERE deal_id = $1 ORDER BY seq"))
            .bind(deal_id)
            .fetch_all(&state.pool)
            .await?;
        let mut ms = rows.iter().map(row_to_view).collect::<Result<Vec<_>>>()?;
        annotate(&mut ms);
        let sum = |pred: fn(MilestoneState) -> bool| ms.iter().filter(|m| pred(m.state)).map(|m| m.amount_cents).sum::<i64>();
        out.push(DealView {
            id: deal_id,
            owner_id: d.get("owner_id"),
            title: d.get("title"),
            buyer: d.get("buyer"),
            seller: d.get("seller"),
            seller_email: d.get("seller_email"),
            created_at: d.get("created_at"),
            total_cents: ms.iter().map(|m| m.amount_cents).sum(),
            held_cents: sum(|s| matches!(s, MilestoneState::Funded | MilestoneState::Delivered | MilestoneState::Verified)),
            released_cents: sum(|s| s == MilestoneState::Released),
            milestones: ms,
        });
    }
    Ok(out)
}

// --- Transitions ------------------------------------------------------------------------------

struct Locked {
    view: MilestoneView,
    release_key: Uuid,
    deal_owner: String,
    seller_email: String,
    deal_title: String,
}

async fn lock(conn: &mut PgConnection, id: Uuid) -> Result<Locked> {
    let r = sqlx::query(&format!("SELECT {MILESTONE_COLS} FROM milestones WHERE id = $1 FOR UPDATE"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| ServiceError::NotFound(format!("milestone {id} not found")))?;
    let view = row_to_view(&r)?;
    let d = sqlx::query("SELECT owner_id, seller_email, title FROM deals WHERE id = $1").bind(view.deal_id).fetch_one(&mut *conn).await?;
    Ok(Locked { release_key: r.get("release_idempotency_key"), deal_owner: d.get("owner_id"), seller_email: d.get("seller_email"), deal_title: d.get("title"), view })
}

async fn previous_state(conn: &mut PgConnection, m: &MilestoneView) -> Result<Option<(i32, MilestoneState)>> {
    if m.seq <= 1 {
        return Ok(None);
    }
    let r = sqlx::query("SELECT seq, state FROM milestones WHERE deal_id = $1 AND seq = $2").bind(m.deal_id).bind(m.seq - 1).fetch_optional(&mut *conn).await?;
    Ok(match r {
        Some(r) => Some((r.get("seq"), parse_state(r.get::<String, _>("state").as_str())?)),
        None => None,
    })
}

fn next(from: MilestoneState, event: MilestoneEvent) -> Result<MilestoneState> {
    from.next(event).map_err(|e| ServiceError::Conflict(e.to_string()))
}

async fn set_state(conn: &mut PgConnection, id: Uuid, from: MilestoneState, to: MilestoneState, kind: &str, extra: Value) -> Result<()> {
    sqlx::query("UPDATE milestones SET state = $1, updated_at = now() WHERE id = $2").bind(state_str(to)).bind(id).execute(&mut *conn).await?;
    let mut payload = json!({ "milestone_id": id, "from": from, "to": to });
    if let (Value::Object(p), Value::Object(e)) = (&mut payload, extra) {
        p.extend(e);
    }
    audit::append(conn, kind, payload).await?;
    Ok(())
}

fn parse_expiry(s: Option<String>) -> Option<DateTime<Utc>> {
    s.and_then(|s| DateTime::parse_from_rfc3339(&s).ok()).map(|d| d.with_timezone(&Utc))
}

#[derive(Debug, Clone, Serialize)]
pub struct FundResponse {
    pub milestone: MilestoneView,
    /// Present when the buyer must approve at PayPal before `confirm`.
    pub approve_url: Option<String>,
}

pub async fn fund(state: &AppState, id: Uuid) -> Result<FundResponse> {
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    if l.view.state != MilestoneState::Draft {
        return Err(ServiceError::Conflict(format!("milestone is {:?}, not Draft", l.view.state)));
    }
    if let Some((seq, s)) = previous_state(&mut tx, &l.view).await?
        && !funded_or_later(s)
    {
        return Err(ServiceError::Conflict(format!("fund milestone {seq} first")));
    }
    // The owner's mandate must be live and cover the currency.
    let mandate = sqlx::query("SELECT rules_json->>'currency' AS currency, expires_at FROM mandates WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1")
        .bind(&l.deal_owner)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ServiceError::Conflict("the owner has no mandate".into()))?;
    if mandate.get::<DateTime<Utc>, _>("expires_at") <= Utc::now() {
        return Err(ServiceError::Conflict("MANDATE_EXPIRED: renew the mandate before funding".into()));
    }
    if mandate.get::<Option<String>, _>("currency").as_deref() != Some(l.view.currency.trim()) {
        return Err(ServiceError::Conflict(format!("the mandate does not cover {}", l.view.currency)));
    }
    let amount = Money { cents: l.view.amount_cents, currency: l.view.currency.clone() };
    let outcome = state.executor.start_funding(id, &amount, &format!("{}-order", l.release_key)).await.map_err(exec_err)?;
    let approve_url = match outcome {
        FundOutcome::NeedsBuyerApproval { order_id, approve_url } => {
            sqlx::query("UPDATE milestones SET paypal_order_id = $1, approve_url = $2, updated_at = now() WHERE id = $3")
                .bind(&order_id)
                .bind(&approve_url)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            audit::append(&mut tx, "milestone.order_created", json!({ "milestone_id": id, "order_id": order_id })).await?;
            Some(approve_url)
        }
        FundOutcome::Authorized { order_id, authorization_id, expires_at } => {
            record_authorization(&mut tx, &l.view, &order_id, &authorization_id, expires_at).await?;
            None
        }
    };
    tx.commit().await?;
    Ok(FundResponse { milestone: one(state, id).await?, approve_url })
}

async fn record_authorization(conn: &mut PgConnection, m: &MilestoneView, order_id: &str, authorization_id: &str, expires_at: Option<String>) -> Result<()> {
    let now = Utc::now();
    let expires = parse_expiry(expires_at).unwrap_or(now + AUTHORIZATION_LIFETIME);
    sqlx::query("UPDATE milestones SET paypal_order_id = $1, authorization_id = $2, authorized_at = $3, auth_expires_at = $4, approve_url = NULL WHERE id = $5")
        .bind(order_id)
        .bind(authorization_id)
        .bind(now)
        .bind(expires)
        .bind(m.id)
        .execute(&mut *conn)
        .await?;
    let to = next(m.state, MilestoneEvent::Fund)?;
    set_state(conn, m.id, m.state, to, "milestone.funded", json!({ "authorization_id": authorization_id, "auth_expires_at": expires.timestamp() })).await
}

/// After the buyer approved the PayPal order: authorize it.
pub async fn confirm_funding(state: &AppState, id: Uuid) -> Result<MilestoneView> {
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    let order_id = match (&l.view.state, &l.view.paypal_order_id) {
        (MilestoneState::Draft, Some(o)) => o.clone(),
        _ => return Err(ServiceError::Conflict("nothing to confirm: fund the milestone first".into())),
    };
    let (auth_id, expires) = state.executor.confirm_funding(&order_id, &format!("{}-authorize", l.release_key)).await.map_err(exec_err)?;
    record_authorization(&mut tx, &l.view, &order_id, &auth_id, expires).await?;
    tx.commit().await?;
    one(state, id).await
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeliverInput {
    pub evidence: String,
    #[serde(default)]
    pub links: Vec<String>,
}

pub async fn deliver(state: &AppState, id: Uuid, input: DeliverInput) -> Result<MilestoneView> {
    if input.evidence.trim().is_empty() {
        return Err(ServiceError::Invalid("evidence is required".into()));
    }
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    if let Some((seq, s)) = previous_state(&mut tx, &l.view).await?
        && !is_closed(s)
    {
        return Err(ServiceError::Conflict(format!("milestone {seq} must be released before this one is delivered")));
    }
    let to = next(l.view.state, MilestoneEvent::Deliver)?;
    let evidence = json!({ "text": input.evidence, "links": input.links });
    let hash = format!("sha256:{}", policy::sha256_hex(evidence.to_string().as_bytes()));
    sqlx::query("UPDATE milestones SET evidence_json = $1, evidence_hash = $2, criteria_result_json = NULL, hold_reasons = NULL, buyer_accepted_hold = false WHERE id = $3")
        .bind(&evidence)
        .bind(&hash)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    set_state(&mut tx, id, l.view.state, to, "milestone.delivered", json!({ "evidence_hash": hash })).await?;
    tx.commit().await?;
    one(state, id).await
}

#[derive(Debug, Clone, Deserialize)]
pub struct CriteriaInput {
    /// Must match the evidence the core holds, so a stale or swapped result is refused.
    pub evidence_hash: String,
    pub results: Vec<CriterionResult>,
    #[serde(default)]
    pub flags: Vec<AiFlag>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CriteriaResponse {
    pub decision: String,
    pub reasons: Vec<Reason>,
    pub milestone: MilestoneView,
}

/// The agent reports its criteria check. All pass: Verified. Otherwise: held for the buyer.
pub async fn record_criteria(state: &AppState, id: Uuid, input: CriteriaInput) -> Result<CriteriaResponse> {
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    if l.view.state != MilestoneState::Delivered {
        return Err(ServiceError::Conflict(format!("milestone is {:?}, not Delivered", l.view.state)));
    }
    if l.view.evidence_hash.as_deref() != Some(input.evidence_hash.as_str()) {
        return Err(ServiceError::Conflict("evidence_hash does not match the delivered evidence".into()));
    }
    let decision = policy::evaluate_criteria(&l.view.criteria, &input.results, &input.flags);
    let result_json = json!({ "results": input.results, "flags": input.flags, "decision": decision.outcome_str() });
    sqlx::query("UPDATE milestones SET criteria_result_json = $1, hold_reasons = $2, updated_at = now() WHERE id = $3")
        .bind(&result_json)
        .bind(serde_json::to_value(decision.reasons()).unwrap())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    match decision {
        Decision::Allow => {
            let to = next(l.view.state, MilestoneEvent::Verify)?;
            set_state(&mut tx, id, l.view.state, to, "milestone.verified", json!({ "by": "criteria", "evidence_hash": input.evidence_hash })).await?;
        }
        _ => {
            audit::append(&mut tx, "milestone.held", json!({ "milestone_id": id, "reasons": decision.reasons(), "evidence_hash": input.evidence_hash })).await?;
        }
    }
    tx.commit().await?;
    Ok(CriteriaResponse { decision: decision.outcome_str().into(), reasons: decision.reasons().to_vec(), milestone: one(state, id).await? })
}

#[derive(Debug, Clone, Deserialize)]
pub struct BuyerDecision {
    pub approver: String,
    pub note: Option<String>,
}

/// The buyer accepts held work anyway (or verifies it before any agent check ran).
pub async fn accept(state: &AppState, id: Uuid, input: BuyerDecision) -> Result<MilestoneView> {
    if input.approver.trim().is_empty() {
        return Err(ServiceError::Invalid("approver is required".into()));
    }
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    let to = next(l.view.state, MilestoneEvent::Verify)?;
    sqlx::query("UPDATE milestones SET buyer_accepted_hold = true WHERE id = $1").bind(id).execute(&mut *tx).await?;
    set_state(&mut tx, id, l.view.state, to, "milestone.verified", json!({ "by": "buyer", "approver": input.approver.trim(), "note": input.note, "overrode": l.view.hold_reasons })).await?;
    tx.commit().await?;
    one(state, id).await
}

/// The buyer rejects the delivery: back to Funded so the seller can redeliver.
pub async fn reject(state: &AppState, id: Uuid, input: BuyerDecision) -> Result<MilestoneView> {
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    let to = next(l.view.state, MilestoneEvent::Reject)?;
    set_state(&mut tx, id, l.view.state, to, "milestone.rejected", json!({ "approver": input.approver.trim(), "note": input.note, "reasons": l.view.hold_reasons })).await?;
    tx.commit().await?;
    one(state, id).await
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseResponse {
    pub milestone: MilestoneView,
    pub execution: String,
}

/// Capture and pay the seller. The only path to `executor.release` goes through
/// `policy::authorize_release`.
pub async fn release(state: &AppState, id: Uuid) -> Result<ReleaseResponse> {
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    let stored = StoredMilestone {
        id,
        state: l.view.state,
        authorization_id: l.view.authorization_id.clone(),
        hold_reasons: l.view.hold_reasons.clone(),
        buyer_accepted_hold: l.view.buyer_accepted_hold,
    };
    let instruction = ReleaseInstruction {
        milestone_id: id,
        authorization_id: l.view.authorization_id.clone().unwrap_or_default(),
        amount: Money { cents: l.view.amount_cents, currency: l.view.currency.clone() },
        seller_email: l.seller_email.clone(),
        note: format!("{}: {}", l.deal_title, l.view.title),
        idempotency_key: l.release_key,
    };
    let auth = policy::authorize_release(&stored, instruction)
        .map_err(|_| ServiceError::Conflict(format!("milestone is {:?}{}; only verified milestones can be released", l.view.state, if stored.hold_reasons.is_empty() || stored.buyer_accepted_hold { "" } else { " and held" })))?;
    // The row stays locked while PayPal is called, so two releases cannot race.
    let outcome = state.executor.release(auth).await;
    let execution = match outcome {
        Ok(o) => {
            sqlx::query("UPDATE milestones SET capture_id = $1, payout_ref = $2, failure = NULL WHERE id = $3").bind(&o.capture_id).bind(&o.payout_ref).bind(id).execute(&mut *tx).await?;
            let to = next(l.view.state, MilestoneEvent::Release)?;
            set_state(&mut tx, id, l.view.state, to, "milestone.released", json!({ "capture_id": o.capture_id, "payout_ref": o.payout_ref, "simulated": o.simulated })).await?;
            if o.simulated { "simulated capture and payout".to_string() } else { format!("captured {} and paid out {}", o.capture_id, o.payout_ref) }
        }
        Err(e) => {
            let msg = e.to_string();
            sqlx::query("UPDATE milestones SET failure = $1, updated_at = now() WHERE id = $2").bind(&msg).bind(id).execute(&mut *tx).await?;
            audit::append(&mut tx, "milestone.release_failed", json!({ "milestone_id": id, "error": msg })).await?;
            format!("release did not complete; safe to retry (same request IDs): {msg}")
        }
    };
    tx.commit().await?;
    Ok(ReleaseResponse { milestone: one(state, id).await?, execution })
}

pub async fn void(state: &AppState, id: Uuid, input: BuyerDecision) -> Result<MilestoneView> {
    let mut tx = state.pool.begin().await?;
    let l = lock(&mut tx, id).await?;
    let to = next(l.view.state, MilestoneEvent::Void)?;
    if let Some(auth) = &l.view.authorization_id {
        state.executor.void(auth, &format!("{}-void", l.release_key)).await.map_err(exec_err)?;
    }
    set_state(&mut tx, id, l.view.state, to, "milestone.voided", json!({ "approver": input.approver.trim(), "note": input.note, "authorization_id": l.view.authorization_id })).await?;
    tx.commit().await?;
    one(state, id).await
}

async fn one(state: &AppState, id: Uuid) -> Result<MilestoneView> {
    let deal_id: Uuid = sqlx::query_scalar("SELECT deal_id FROM milestones WHERE id = $1").bind(id).fetch_one(&state.pool).await?;
    get_deal(state, deal_id).await?.milestones.into_iter().find(|m| m.id == id).ok_or_else(|| ServiceError::NotFound("milestone vanished".into()))
}

fn exec_err(e: ExecError) -> ServiceError {
    match e {
        ExecError::Rejected(m) => ServiceError::Conflict(format!("PayPal refused: {m}")),
        ExecError::Unknown(m) => ServiceError::Unavailable(format!("PayPal outcome unknown, retry: {m}")),
    }
}

// --- Day-3 job -------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
pub struct ReauthorizeReport {
    pub checked: usize,
    pub reauthorized: Vec<Uuid>,
    pub expired: Vec<Uuid>,
    pub errors: Vec<String>,
    /// Payments waiting for a human for more than a day (for reminders).
    pub stale_approvals: i64,
}

/// Renews holds that have passed the 3-day honor period (once, as PayPal allows) and expires
/// milestones whose authorization has lapsed. Safe to run as often as you like.
pub async fn reauthorize_due(state: &AppState, now: DateTime<Utc>) -> Result<ReauthorizeReport> {
    let mut report = ReauthorizeReport::default();
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM milestones WHERE state IN ('FUNDED', 'DELIVERED', 'VERIFIED') AND authorization_id IS NOT NULL")
        .fetch_all(&state.pool)
        .await?;
    report.checked = ids.len();
    for id in ids {
        let mut tx = state.pool.begin().await?;
        let l = lock(&mut tx, id).await?;
        let m = &l.view;
        if m.auth_expires_at.is_some_and(|e| e <= now) {
            let to = next(m.state, MilestoneEvent::Expire)?;
            set_state(&mut tx, id, m.state, to, "milestone.expired", json!({ "authorization_id": m.authorization_id })).await?;
            report.expired.push(id);
        } else if m.reauthorized_count == 0 && m.authorized_at.is_some_and(|a| a + HONOR_PERIOD <= now) {
            let old = m.authorization_id.clone().unwrap_or_default();
            match state.executor.reauthorize(&old, &format!("{}-reauth-1", l.release_key)).await {
                Ok((new_id, expires)) => {
                    let expires = parse_expiry(expires).or(m.auth_expires_at);
                    sqlx::query("UPDATE milestones SET authorization_id = $1, authorized_at = $2, auth_expires_at = $3, reauthorized_count = reauthorized_count + 1, updated_at = now() WHERE id = $4")
                        .bind(&new_id)
                        .bind(now)
                        .bind(expires)
                        .bind(id)
                        .execute(&mut *tx)
                        .await?;
                    let s = next(m.state, MilestoneEvent::Reauthorize)?;
                    set_state(&mut tx, id, m.state, s, "milestone.reauthorized", json!({ "old_authorization_id": old, "authorization_id": new_id })).await?;
                    report.reauthorized.push(id);
                }
                Err(e) => report.errors.push(format!("{id}: {e}")),
            }
        }
        tx.commit().await?;
    }
    report.stale_approvals = sqlx::query_scalar("SELECT COUNT(*) FROM payments WHERE state = 'NEEDS_APPROVAL' AND created_at < $1")
        .bind(now - Duration::days(1))
        .fetch_one(&state.pool)
        .await?;
    Ok(report)
}
