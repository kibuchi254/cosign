//! The one door to money movement. `pay` takes an `Authorized<PaymentInstruction>` by
//! value, which only the policy module can create, and consumes it so it cannot be reused.

use crate::money::Money;
use crate::paypal::{PayPalClient, PayPalError, PayoutRequest};
use crate::policy::Authorized;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct PaymentInstruction {
    pub payment_id: Uuid,
    pub amount: Money,
    pub receiver_email: String,
    pub note: String,
    pub idempotency_key: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecOutcome {
    /// PayPal accepted the payout; a webhook will confirm it.
    Submitted { payout_ref: String, batch_status: String },
    /// Simulation mode (no PayPal credentials): settled instantly, nothing left this box.
    Simulated { payout_ref: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    /// PayPal definitely refused; nothing was paid.
    #[error("PayPal rejected the payout: {0}")]
    Rejected(String),
    /// The outcome is unknown (network, 5xx). Retry later with the same idempotency key.
    #[error("payout outcome unknown: {0}")]
    Unknown(String),
}

#[derive(Clone)]
pub enum Backend {
    Live(Arc<PayPalClient>),
    Simulated,
}

#[derive(Clone)]
pub struct PayPalExecutor {
    backend: Backend,
}

impl PayPalExecutor {
    pub fn new(backend: Backend) -> Self {
        PayPalExecutor { backend }
    }

    pub fn is_live(&self) -> bool {
        matches!(self.backend, Backend::Live(_))
    }

    pub async fn pay(&self, auth: Authorized<PaymentInstruction>) -> Result<ExecOutcome, ExecError> {
        let p = auth.inner();
        match &self.backend {
            Backend::Simulated => Ok(ExecOutcome::Simulated { payout_ref: format!("SIM-{}", p.idempotency_key.simple()) }),
            Backend::Live(client) => {
                let batch_id = p.idempotency_key.to_string();
                let item_id = p.payment_id.to_string();
                let value = p.amount.to_paypal_value();
                let req = PayoutRequest {
                    sender_batch_id: &batch_id,
                    sender_item_id: &item_id,
                    receiver_email: &p.receiver_email,
                    value: &value,
                    currency: &p.amount.currency,
                    note: &p.note,
                };
                match client.create_payout(&req).await {
                    Ok(r) => Ok(ExecOutcome::Submitted { payout_ref: r.payout_batch_id, batch_status: r.batch_status }),
                    Err(e) if is_duplicate_batch(&e) => Err(ExecError::Unknown(format!("batch {batch_id} already exists at PayPal: {e}"))),
                    Err(e) if e.is_definite_rejection() => Err(ExecError::Rejected(e.to_string())),
                    Err(e) => Err(ExecError::Unknown(e.to_string())),
                }
            }
        }
    }
}

/// PayPal answers a reused sender_batch_id with a 4xx, but that means "already sent", not
/// "refused", so it must not mark the payment failed.
fn is_duplicate_batch(e: &PayPalError) -> bool {
    matches!(e, PayPalError::Api { body, .. } if body.contains("DUPLICATE_REQUEST_ID") || body.contains("SENDER_BATCH_ID_ALREADY_EXISTS"))
}

// --- Milestone escrow ----------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ReleaseInstruction {
    pub milestone_id: Uuid,
    pub authorization_id: String,
    pub amount: Money,
    pub seller_email: String,
    pub note: String,
    /// Reused on every attempt: `<key>-capture` for the capture, `<key>` for the payout.
    pub idempotency_key: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseOutcome {
    pub capture_id: String,
    pub payout_ref: String,
    pub simulated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FundOutcome {
    /// The buyer must approve at PayPal, then call confirm.
    NeedsBuyerApproval { order_id: String, approve_url: String },
    /// Simulation: authorized instantly.
    Authorized { order_id: String, authorization_id: String, expires_at: Option<String> },
}

impl PayPalExecutor {
    /// Starts funding a milestone: an AUTHORIZE order the buyer approves. No money moves
    /// until capture, so this needs no `Authorized` value.
    pub async fn start_funding(&self, milestone_id: Uuid, amount: &Money, request_id: &str) -> Result<FundOutcome, ExecError> {
        match &self.backend {
            Backend::Simulated => Ok(FundOutcome::Authorized {
                order_id: format!("SIM-ORDER-{}", milestone_id.simple()),
                authorization_id: format!("SIM-AUTH-{}", Uuid::new_v4().simple()),
                expires_at: Some((chrono::Utc::now() + chrono::Duration::days(29)).to_rfc3339()),
            }),
            Backend::Live(c) => {
                let order = c
                    .create_authorize_order(&amount.to_paypal_value(), &amount.currency, &milestone_id.to_string(), request_id)
                    .await
                    .map_err(classify)?;
                let approve_url = order.approve_url.ok_or_else(|| ExecError::Rejected("PayPal returned no approve link".into()))?;
                Ok(FundOutcome::NeedsBuyerApproval { order_id: order.id, approve_url })
            }
        }
    }

    /// After the buyer approved: place the authorization (the hold on the buyer's funds).
    pub async fn confirm_funding(&self, order_id: &str, request_id: &str) -> Result<(String, Option<String>), ExecError> {
        match &self.backend {
            Backend::Simulated => Ok((format!("SIM-AUTH-{}", Uuid::new_v4().simple()), None)),
            Backend::Live(c) => {
                let a = c.authorize_order(order_id, request_id).await.map_err(classify)?;
                Ok((a.id, a.expiration_time))
            }
        }
    }

    /// Capture the buyer's funds, then pay the seller. Only reachable with an `Authorized`
    /// release, which only `policy::authorize_release` creates.
    pub async fn release(&self, auth: Authorized<ReleaseInstruction>) -> Result<ReleaseOutcome, ExecError> {
        let r = auth.inner();
        match &self.backend {
            Backend::Simulated => Ok(ReleaseOutcome {
                capture_id: format!("SIM-CAP-{}", r.idempotency_key.simple()),
                payout_ref: format!("SIM-{}", r.idempotency_key.simple()),
                simulated: true,
            }),
            Backend::Live(c) => {
                let capture = c
                    .capture_authorization(&r.authorization_id, &format!("{}-capture", r.idempotency_key))
                    .await
                    .map_err(classify)?;
                let capture_id = capture.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let batch = r.idempotency_key.to_string();
                let item = r.milestone_id.to_string();
                let value = r.amount.to_paypal_value();
                let payout = c
                    .create_payout(&PayoutRequest { sender_batch_id: &batch, sender_item_id: &item, receiver_email: &r.seller_email, value: &value, currency: &r.amount.currency, note: &r.note })
                    .await
                    .map_err(|e| match classify(e) {
                        // The capture already happened; the payout must be retried, never re-captured blindly.
                        ExecError::Rejected(m) | ExecError::Unknown(m) => ExecError::Unknown(format!("captured {capture_id}, payout pending: {m}")),
                    })?;
                Ok(ReleaseOutcome { capture_id, payout_ref: payout.payout_batch_id, simulated: false })
            }
        }
    }

    pub async fn void(&self, authorization_id: &str, request_id: &str) -> Result<(), ExecError> {
        match &self.backend {
            Backend::Simulated => Ok(()),
            Backend::Live(c) => c.void_authorization(authorization_id, request_id).await.map_err(classify),
        }
    }

    /// Renews a hold past PayPal's 3-day honor period. Returns the new authorization ID.
    pub async fn reauthorize(&self, authorization_id: &str, request_id: &str) -> Result<(String, Option<String>), ExecError> {
        match &self.backend {
            Backend::Simulated => Ok((format!("SIM-AUTH-{}", Uuid::new_v4().simple()), None)),
            Backend::Live(c) => {
                let a = c.reauthorize(authorization_id, request_id).await.map_err(classify)?;
                Ok((a.id, a.expiration_time))
            }
        }
    }

    /// The live client, for read-only uses such as handing the agent a short-lived token.
    pub fn live_client(&self) -> Option<&Arc<PayPalClient>> {
        match &self.backend {
            Backend::Live(c) => Some(c),
            Backend::Simulated => None,
        }
    }
}

fn classify(e: PayPalError) -> ExecError {
    if e.is_definite_rejection() { ExecError::Rejected(e.to_string()) } else { ExecError::Unknown(e.to_string()) }
}
