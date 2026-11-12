//! HTTP surface. Two bearer tokens split the callers: the agent token may only submit
//! proposals; the operator token (the React app) may approve, edit mandates and vendors.
//! So a fooled agent cannot approve its own proposal even if it tries.

use crate::audit;
use crate::milestones;
use crate::service::{self, AppState, ServiceError};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Agent,
    Operator,
    Internal,
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            ServiceError::Invalid(_) => (StatusCode::UNPROCESSABLE_ENTITY, "invalid"),
            ServiceError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            ServiceError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            ServiceError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            ServiceError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ServiceError::Db(e) => {
                tracing::error!(error = %e, "database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        };
        let message = match &self {
            ServiceError::Db(_) => "internal error".to_string(),
            other => other.to_string(),
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

/// Constant-time comparison so the token cannot be guessed byte by byte from timings.
fn token_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn role_of(state: &AppState, headers: &HeaderMap) -> Option<Role> {
    let token = headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?;
    if token_eq(token, &state.operator_token) {
        Some(Role::Operator)
    } else if state.internal_token.as_deref().is_some_and(|t| token_eq(token, t)) {
        Some(Role::Internal)
    } else if token_eq(token, &state.agent_token) {
        Some(Role::Agent)
    } else {
        None
    }
}

fn require(state: &AppState, headers: &HeaderMap, allowed: &[Role]) -> Result<Role, ServiceError> {
    match role_of(state, headers) {
        Some(r) if allowed.contains(&r) => Ok(r),
        Some(_) => Err(ServiceError::Unauthorized("this token may not call this endpoint".into())),
        None => Err(ServiceError::Unauthorized("missing or unknown bearer token".into())),
    }
}

#[derive(Deserialize)]
struct OwnerQuery {
    owner: Option<String>,
}

#[derive(Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/proposals", post(propose))
        .route("/v1/approvals/{payment_id}", post(approve))
        .route("/v1/ledger", get(ledger))
        .route("/v1/mandates", post(create_mandate))
        .route("/v1/mandates/active", get(active_mandate))
        .route("/v1/vendors", get(list_vendors).post(create_vendor))
        .route("/v1/audit", get(recent_audit))
        .route("/v1/audit/verify", get(verify_audit))
        .route("/v1/payments/{payment_id}/retry", post(retry_payment))
        .route("/v1/deals", get(list_deals).post(create_deal))
        .route("/v1/deals/{deal_id}", get(get_deal))
        .route("/v1/milestones/{id}/fund", post(fund))
        .route("/v1/milestones/{id}/fund/confirm", post(confirm_fund))
        .route("/v1/milestones/{id}/deliver", post(deliver))
        .route("/v1/milestones/{id}/criteria-result", post(criteria_result))
        .route("/v1/milestones/{id}/accept", post(accept))
        .route("/v1/milestones/{id}/reject", post(reject))
        .route("/v1/milestones/{id}/release", post(release))
        .route("/v1/milestones/{id}/void", post(void))
        .route("/v1/agent/paypal-token", get(agent_token))
        .route("/internal/reauthorize", post(reauthorize))
        .route("/openapi.json", get(openapi))
        .route("/webhooks/paypal", post(webhook))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let db = sqlx::query("SELECT 1").execute(&state.pool).await.is_ok();
    let status = if db { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(json!({ "ok": db, "paypal": if state.executor.is_live() { "live" } else { "simulated" } })))
}

async fn propose(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<service::ProposalInput>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Agent, Role::Operator])?;
    Ok((StatusCode::CREATED, Json(service::propose(&state, body).await?)))
}

async fn approve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(payment_id): Path<Uuid>,
    Json(body): Json<service::ApprovalBody>,
) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(service::approve(&state, payment_id, body).await?))
}

async fn ledger(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<OwnerQuery>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(service::ledger(&state, q.owner).await?))
}

async fn create_mandate(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<service::MandateInput>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok((StatusCode::CREATED, Json(service::create_mandate(&state, body).await?)))
}

async fn active_mandate(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<OwnerQuery>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Agent, Role::Operator])?;
    Ok(Json(service::get_active_mandate(&state, q.owner).await?))
}

async fn list_vendors(State(state): State<AppState>, headers: HeaderMap) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(service::list_vendors(&state).await?))
}

async fn create_vendor(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<service::VendorInput>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok((StatusCode::CREATED, Json(service::create_vendor(&state, body).await?)))
}

async fn recent_audit(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<LimitQuery>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(service::recent_audit(&state, q.limit.unwrap_or(100)).await?))
}

/// Public on purpose: anyone can check the chain.
async fn verify_audit(State(state): State<AppState>) -> Result<impl IntoResponse, ServiceError> {
    Ok(Json(audit::verify(&state.pool).await?))
}

async fn webhook(State(state): State<AppState>, headers: HeaderMap, body: String) -> Result<impl IntoResponse, ServiceError> {
    let result = service::handle_webhook(&state, &headers, &body).await?;
    if !result.duplicate {
        tracing::info!(event_id = %result.event_id, event_type = %result.event_type, applied = ?result.applied, "webhook processed");
    }
    Ok(Json(result))
}

// --- Payments retry, deals and milestones ---------------------------------------------------------

async fn retry_payment(State(state): State<AppState>, headers: HeaderMap, Path(payment_id): Path<Uuid>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(service::retry_payment(&state, payment_id).await?))
}

async fn list_deals(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<OwnerQuery>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::list_deals(&state, q.owner).await?))
}

async fn get_deal(State(state): State<AppState>, headers: HeaderMap, Path(deal_id): Path<Uuid>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator, Role::Agent])?;
    Ok(Json(milestones::get_deal(&state, deal_id).await?))
}

async fn create_deal(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<milestones::DealInput>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok((StatusCode::CREATED, Json(milestones::create_deal(&state, body).await?)))
}

async fn fund(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::fund(&state, id).await?))
}

async fn confirm_fund(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::confirm_funding(&state, id).await?))
}

async fn deliver(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>, Json(body): Json<milestones::DeliverInput>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::deliver(&state, id, body).await?))
}

/// The agent reports its check. It can verify or hold; it cannot release.
async fn criteria_result(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>, Json(body): Json<milestones::CriteriaInput>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Agent, Role::Operator])?;
    Ok(Json(milestones::record_criteria(&state, id, body).await?))
}

async fn accept(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>, Json(body): Json<milestones::BuyerDecision>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::accept(&state, id, body).await?))
}

async fn reject(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>, Json(body): Json<milestones::BuyerDecision>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::reject(&state, id, body).await?))
}

async fn release(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::release(&state, id).await?))
}

async fn void(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>, Json(body): Json<milestones::BuyerDecision>) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Operator])?;
    Ok(Json(milestones::void(&state, id, body).await?))
}

async fn agent_token(State(state): State<AppState>, headers: HeaderMap) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Agent])?;
    Ok(Json(service::agent_read_token(&state).await?))
}

async fn reauthorize(State(state): State<AppState>, headers: HeaderMap) -> Result<impl IntoResponse, ServiceError> {
    require(&state, &headers, &[Role::Internal, Role::Operator])?;
    Ok(Json(milestones::reauthorize_due(&state, chrono::Utc::now()).await?))
}

pub const OPENAPI: &str = include_str!("../openapi.json");

async fn openapi() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/json")], OPENAPI)
}
