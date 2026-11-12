//! PayPal REST client. This is the only code in Cosign that holds the client secret.
//! Plain reqwest against the REST API: OAuth, Payouts, Orders (authorize, capture,
//! reauthorize, void) and webhook signature verification.

use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const SANDBOX_BASE_URL: &str = "https://api-m.sandbox.paypal.com";
const MAX_ATTEMPTS: u32 = 4;
/// Refresh this long before PayPal's stated expiry, so no request carries a dying token.
const TOKEN_MARGIN: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct PayPalConfig {
    pub base_url: String,
    pub client_id: String,
    pub secret: String,
    /// The webhook ID from the developer dashboard; needed to verify signatures.
    pub webhook_id: Option<String>,
}

impl PayPalConfig {
    pub fn from_env() -> Option<Self> {
        let client_id = std::env::var("PAYPAL_CLIENT_ID").ok().filter(|s| !s.is_empty())?;
        let secret = std::env::var("PAYPAL_SECRET").ok().filter(|s| !s.is_empty())?;
        Some(PayPalConfig {
            base_url: std::env::var("PAYPAL_BASE_URL").unwrap_or_else(|_| SANDBOX_BASE_URL.to_string()),
            client_id,
            secret,
            webhook_id: std::env::var("PAYPAL_WEBHOOK_ID").ok().filter(|s| !s.is_empty()),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PayPalError {
    #[error("network error calling PayPal: {0}")]
    Network(#[from] reqwest::Error),
    #[error("PayPal {status} on {path}: {body}")]
    Api { status: u16, path: String, body: String },
    #[error("PayPal response was missing {0}")]
    Shape(&'static str),
    #[error("{0}")]
    Config(&'static str),
}

impl PayPalError {
    /// A definite rejection (4xx other than 429): retrying with the same request will not
    /// succeed and nothing was paid.
    pub fn is_definite_rejection(&self) -> bool {
        matches!(self, PayPalError::Api { status, .. } if (400..500).contains(status) && *status != 429)
    }
}

pub struct PayPalClient {
    http: reqwest::Client,
    cfg: PayPalConfig,
    token: Mutex<Option<(String, Instant)>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

impl PayPalClient {
    pub fn new(cfg: PayPalConfig) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("reqwest client");
        PayPalClient { http, cfg, token: Mutex::new(None) }
    }

    pub fn config(&self) -> &PayPalConfig {
        &self.cfg
    }

    /// A cached OAuth token, refreshed well before expiry (sandbox tokens last hours).
    pub async fn access_token(&self) -> Result<String, PayPalError> {
        let mut guard = self.token.lock().await;
        if let Some((tok, expires)) = guard.as_ref()
            && Instant::now() < *expires
        {
            return Ok(tok.clone());
        }
        let res = self
            .http
            .post(format!("{}/v1/oauth2/token", self.cfg.base_url))
            .basic_auth(&self.cfg.client_id, Some(&self.cfg.secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            return Err(PayPalError::Api { status: status.as_u16(), path: "/v1/oauth2/token".into(), body: res.text().await.unwrap_or_default() });
        }
        let t: TokenResponse = res.json().await?;
        let ttl = Duration::from_secs(t.expires_in).saturating_sub(TOKEN_MARGIN);
        *guard = Some((t.access_token.clone(), Instant::now() + ttl));
        Ok(t.access_token)
    }

    async fn clear_token(&self) {
        *self.token.lock().await = None;
    }

    /// One call with the retry policy: a 401 drops the token and retries once; 429 and 5xx
    /// back off and retry. Money calls carry `PayPal-Request-Id`, which makes the retries safe.
    async fn call(&self, method: Method, path: &str, body: Option<String>, request_id: Option<&str>) -> Result<Value, PayPalError> {
        let mut refreshed = false;
        for attempt in 1..=MAX_ATTEMPTS {
            let token = self.access_token().await?;
            let mut req = self
                .http
                .request(method.clone(), format!("{}{}", self.cfg.base_url, path))
                .bearer_auth(token)
                .header("Content-Type", "application/json")
                .header("Prefer", "return=representation");
            if let Some(id) = request_id {
                req = req.header("PayPal-Request-Id", id);
            }
            if let Some(b) = &body {
                req = req.body(b.clone());
            }
            let res = match req.send().await {
                Ok(r) => r,
                Err(e) if attempt < MAX_ATTEMPTS && (e.is_timeout() || e.is_connect()) => {
                    backoff(attempt).await;
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            let status = res.status();
            if status.is_success() {
                let text = res.text().await?;
                return Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) });
            }
            if status == StatusCode::UNAUTHORIZED && !refreshed {
                refreshed = true;
                self.clear_token().await;
                continue;
            }
            if (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) && attempt < MAX_ATTEMPTS {
                backoff(attempt).await;
                continue;
            }
            return Err(PayPalError::Api { status: status.as_u16(), path: path.to_string(), body: res.text().await.unwrap_or_default() });
        }
        Err(PayPalError::Config("retries exhausted"))
    }

    // --- Payouts ----------------------------------------------------------------------

    /// Sends one payout. `sender_batch_id` doubles as PayPal's own duplicate guard: PayPal
    /// rejects a second batch with the same ID, so use the payment's idempotency key.
    pub async fn create_payout(&self, p: &PayoutRequest<'_>) -> Result<PayoutResult, PayPalError> {
        let body = json!({
            "sender_batch_header": {
                "sender_batch_id": p.sender_batch_id,
                "email_subject": "You have a payment from Cosign",
                "email_message": p.note,
            },
            "items": [{
                "recipient_type": "EMAIL",
                "amount": { "value": p.value, "currency": p.currency },
                "receiver": p.receiver_email,
                "note": p.note,
                "sender_item_id": p.sender_item_id,
            }]
        });
        let v = self.call(Method::POST, "/v1/payments/payouts", Some(body.to_string()), Some(p.sender_batch_id)).await?;
        let header = v.get("batch_header").ok_or(PayPalError::Shape("batch_header"))?;
        Ok(PayoutResult {
            payout_batch_id: str_at(header, "payout_batch_id").ok_or(PayPalError::Shape("payout_batch_id"))?,
            batch_status: str_at(header, "batch_status").unwrap_or_default(),
        })
    }

    pub async fn get_payout(&self, payout_batch_id: &str) -> Result<Value, PayPalError> {
        self.call(Method::GET, &format!("/v1/payments/payouts/{payout_batch_id}"), None, None).await
    }

    // --- Orders: authorize, capture, reauthorize, void (milestone escrow) ----------------

    /// Creates an AUTHORIZE order. The buyer must open the returned approve link.
    pub async fn create_authorize_order(&self, value: &str, currency: &str, reference: &str, request_id: &str) -> Result<CreatedOrder, PayPalError> {
        let body = json!({
            "intent": "AUTHORIZE",
            "purchase_units": [{ "reference_id": reference, "amount": { "currency_code": currency, "value": value } }],
            "payment_source": { "paypal": { "experience_context": {
                "user_action": "PAY_NOW",
                "return_url": "https://example.com/return",
                "cancel_url": "https://example.com/cancel"
            } } }
        });
        let v = self.call(Method::POST, "/v2/checkout/orders", Some(body.to_string()), Some(request_id)).await?;
        let approve_url = v
            .get("links")
            .and_then(Value::as_array)
            .and_then(|links| links.iter().find(|l| matches!(str_at(l, "rel").as_deref(), Some("approve" | "payer-action"))))
            .and_then(|l| str_at(l, "href"));
        Ok(CreatedOrder { id: str_at(&v, "id").ok_or(PayPalError::Shape("order id"))?, approve_url })
    }

    /// Authorizes an approved order. Returns the authorization ID and its expiry.
    pub async fn authorize_order(&self, order_id: &str, request_id: &str) -> Result<AuthorizationResult, PayPalError> {
        let v = self.call(Method::POST, &format!("/v2/checkout/orders/{order_id}/authorize"), Some("{}".into()), Some(request_id)).await?;
        let auth = v
            .pointer("/purchase_units/0/payments/authorizations/0")
            .ok_or(PayPalError::Shape("authorization"))?;
        Ok(AuthorizationResult {
            id: str_at(auth, "id").ok_or(PayPalError::Shape("authorization id"))?,
            status: str_at(auth, "status").unwrap_or_default(),
            expiration_time: str_at(auth, "expiration_time"),
        })
    }

    pub async fn capture_authorization(&self, authorization_id: &str, request_id: &str) -> Result<Value, PayPalError> {
        let body = json!({ "final_capture": true });
        self.call(Method::POST, &format!("/v2/payments/authorizations/{authorization_id}/capture"), Some(body.to_string()), Some(request_id)).await
    }

    pub async fn reauthorize(&self, authorization_id: &str, request_id: &str) -> Result<AuthorizationResult, PayPalError> {
        let v = self.call(Method::POST, &format!("/v2/payments/authorizations/{authorization_id}/reauthorize"), Some("{}".into()), Some(request_id)).await?;
        Ok(AuthorizationResult {
            id: str_at(&v, "id").ok_or(PayPalError::Shape("authorization id"))?,
            status: str_at(&v, "status").unwrap_or_default(),
            expiration_time: str_at(&v, "expiration_time"),
        })
    }

    pub async fn void_authorization(&self, authorization_id: &str, request_id: &str) -> Result<(), PayPalError> {
        self.call(Method::POST, &format!("/v2/payments/authorizations/{authorization_id}/void"), None, Some(request_id)).await?;
        Ok(())
    }

    // --- Webhooks -------------------------------------------------------------------------

    /// Asks PayPal whether a webhook delivery is genuine. The raw body is spliced in
    /// unchanged: re-serializing the event can alter it and make verification fail.
    pub async fn verify_webhook(&self, h: &WebhookHeaders, raw_body: &str) -> Result<bool, PayPalError> {
        let webhook_id = self.cfg.webhook_id.as_deref().ok_or(PayPalError::Config("PAYPAL_WEBHOOK_ID is not set"))?;
        // Refuse anything that is not one JSON object before splicing it into our request.
        match serde_json::from_str::<Value>(raw_body) {
            Ok(Value::Object(_)) => {}
            _ => return Ok(false),
        }
        let s = |v: &str| Value::String(v.to_string()).to_string();
        let body = format!(
            r#"{{"auth_algo":{},"cert_url":{},"transmission_id":{},"transmission_sig":{},"transmission_time":{},"webhook_id":{},"webhook_event":{}}}"#,
            s(&h.auth_algo), s(&h.cert_url), s(&h.transmission_id), s(&h.transmission_sig), s(&h.transmission_time), s(webhook_id), raw_body
        );
        let v = self.call(Method::POST, "/v1/notifications/verify-webhook-signature", Some(body), None).await?;
        Ok(str_at(&v, "verification_status").as_deref() == Some("SUCCESS"))
    }
}

async fn backoff(attempt: u32) {
    tokio::time::sleep(Duration::from_millis(250 * 2u64.pow(attempt))).await;
}

fn str_at(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

pub struct PayoutRequest<'a> {
    pub sender_batch_id: &'a str,
    pub sender_item_id: &'a str,
    pub receiver_email: &'a str,
    pub value: &'a str,
    pub currency: &'a str,
    pub note: &'a str,
}

#[derive(Debug, Clone)]
pub struct PayoutResult {
    pub payout_batch_id: String,
    pub batch_status: String,
}

#[derive(Debug, Clone)]
pub struct CreatedOrder {
    pub id: String,
    pub approve_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthorizationResult {
    pub id: String,
    pub status: String,
    pub expiration_time: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WebhookHeaders {
    pub auth_algo: String,
    pub cert_url: String,
    pub transmission_id: String,
    pub transmission_sig: String,
    pub transmission_time: String,
}

impl WebhookHeaders {
    pub fn from_http(headers: &axum::http::HeaderMap) -> Option<Self> {
        let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string).filter(|s| !s.is_empty());
        Some(WebhookHeaders {
            auth_algo: get("paypal-auth-algo")?,
            cert_url: get("paypal-cert-url")?,
            transmission_id: get("paypal-transmission-id")?,
            transmission_sig: get("paypal-transmission-sig")?,
            transmission_time: get("paypal-transmission-time")?,
        })
    }
}
