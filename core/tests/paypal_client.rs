//! The PayPal client against a local fake of the PayPal API: token caching, the single
//! retry on 401, backoff on 5xx, PayPal-Request-Id on money calls and raw-body webhook
//! verification. The real sandbox is exercised by `cargo run --bin cosign-spike`.

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
};
use cosign_core::paypal::{PayPalClient, PayPalConfig, PayoutRequest, WebhookHeaders};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Fake {
    tokens_issued: u32,
    payout_calls: u32,
    request_ids: Vec<String>,
    fail_first_payout_with: Option<u16>,
    verify_bodies: Vec<String>,
    order_bodies: Vec<Value>,
}

type Shared = Arc<Mutex<Fake>>;

async fn token(State(s): State<Shared>) -> impl IntoResponse {
    let mut f = s.lock().unwrap();
    f.tokens_issued += 1;
    Json(json!({ "access_token": format!("tok-{}", f.tokens_issued), "expires_in": 32400 }))
}

async fn payouts(State(s): State<Shared>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let mut f = s.lock().unwrap();
    f.payout_calls += 1;
    f.request_ids.push(headers.get("paypal-request-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string());
    if let Some(code) = f.fail_first_payout_with.take() {
        return (StatusCode::from_u16(code).unwrap(), Json(json!({ "name": "SIMULATED" }))).into_response();
    }
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
    let v: Value = serde_json::from_slice(&body).unwrap();
    (
        StatusCode::CREATED,
        Json(json!({ "batch_header": { "payout_batch_id": format!("PB-{}", v["sender_batch_header"]["sender_batch_id"].as_str().unwrap()), "batch_status": "PENDING", "auth_seen": auth } })),
    )
        .into_response()
}

async fn verify(State(s): State<Shared>, body: String) -> impl IntoResponse {
    s.lock().unwrap().verify_bodies.push(body.clone());
    let v: Value = serde_json::from_str(&body).unwrap();
    let ok = v["transmission_sig"] == "good";
    Json(json!({ "verification_status": if ok { "SUCCESS" } else { "FAILURE" } }))
}

async fn orders(State(s): State<Shared>, body: Bytes) -> impl IntoResponse {
    s.lock().unwrap().order_bodies.push(serde_json::from_slice(&body).unwrap());
    (StatusCode::CREATED, Json(json!({ "id": "ORDER-1", "links": [{ "rel": "payer-action", "href": "https://paypal.test/approve" }] })))
}

async fn start() -> (Shared, PayPalClient) {
    let shared: Shared = Arc::default();
    let app = Router::new()
        .route("/v1/oauth2/token", post(token))
        .route("/v1/payments/payouts", post(payouts))
        .route("/v1/notifications/verify-webhook-signature", post(verify))
        .route("/v2/checkout/orders", post(orders))
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = PayPalClient::new(PayPalConfig {
        base_url: format!("http://{addr}"),
        client_id: "id".into(),
        secret: "secret".into(),
        webhook_id: Some("WH-123".into()),
        public_url: "https://cosign.test".into(),
    });
    (shared, client)
}

fn payout<'a>(batch: &'a str) -> PayoutRequest<'a> {
    PayoutRequest { sender_batch_id: batch, sender_item_id: "item-1", receiver_email: "r@example.com", value: "10.00", currency: "USD", note: "n" }
}

#[tokio::test]
async fn token_is_cached_and_request_id_is_sent() {
    let (fake, client) = start().await;
    client.create_payout(&payout("b1")).await.unwrap();
    client.create_payout(&payout("b2")).await.unwrap();
    let f = fake.lock().unwrap();
    assert_eq!(f.tokens_issued, 1);
    assert_eq!(f.request_ids, vec!["b1", "b2"]);
}

#[tokio::test]
async fn a_401_refreshes_the_token_once_and_retries_with_the_same_request_id() {
    let (fake, client) = start().await;
    fake.lock().unwrap().fail_first_payout_with = Some(401);
    let r = client.create_payout(&payout("b-401")).await.unwrap();
    assert_eq!(r.payout_batch_id, "PB-b-401");
    let f = fake.lock().unwrap();
    assert_eq!(f.tokens_issued, 2);
    assert_eq!(f.request_ids, vec!["b-401", "b-401"]);
}

#[tokio::test]
async fn a_503_is_retried_with_backoff() {
    let (fake, client) = start().await;
    fake.lock().unwrap().fail_first_payout_with = Some(503);
    client.create_payout(&payout("b-503")).await.unwrap();
    assert_eq!(fake.lock().unwrap().payout_calls, 2);
}

#[tokio::test]
async fn a_422_is_a_definite_rejection_and_not_retried() {
    let (fake, client) = start().await;
    fake.lock().unwrap().fail_first_payout_with = Some(422);
    let err = client.create_payout(&payout("b-422")).await.unwrap_err();
    assert!(err.is_definite_rejection());
    assert_eq!(fake.lock().unwrap().payout_calls, 1);
}

#[tokio::test]
async fn webhook_body_is_forwarded_byte_for_byte() {
    let (fake, client) = start().await;
    // Odd spacing and key order that a re-serialization would change.
    let raw = r#"{ "id":"WH-1",  "event_type" : "X", "resource":{"z":1,"a":2.50}}"#;
    let mut h = WebhookHeaders { auth_algo: "SHA256withRSA".into(), cert_url: "https://c".into(), transmission_id: "t".into(), transmission_sig: "good".into(), transmission_time: "now".into() };
    assert!(client.verify_webhook(&h, raw).await.unwrap());
    h.transmission_sig = "bad".into();
    assert!(!client.verify_webhook(&h, raw).await.unwrap());
    // Not a JSON object: refused locally, never spliced into the request.
    assert!(!client.verify_webhook(&h, r#"1}, "injected": {"#).await.unwrap());
    let f = fake.lock().unwrap();
    assert_eq!(f.verify_bodies.len(), 2);
    assert!(f.verify_bodies[0].ends_with(&format!(r#""webhook_event":{raw}}}"#)));
    assert!(f.verify_bodies[0].contains(r#""webhook_id":"WH-123""#));
}

#[tokio::test]
async fn paypal_sends_the_buyer_back_to_the_app() {
    let (fake, client) = start().await;
    let order = client.create_authorize_order("500.00", "USD", "m-1", "req-1").await.unwrap();
    assert_eq!(order.approve_url.as_deref(), Some("https://paypal.test/approve"));
    let ctx = &fake.lock().unwrap().order_bodies[0]["payment_source"]["paypal"]["experience_context"];
    assert_eq!(ctx["return_url"], "https://cosign.test/console/milestones?paypal=approved");
    assert_eq!(ctx["cancel_url"], "https://cosign.test/console/milestones?paypal=cancelled");
}
