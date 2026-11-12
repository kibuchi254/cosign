//! The Oct 18 gate check. Runs each PayPal call the core depends on against the sandbox and
//! prints PASS/FAIL per step:
//!
//!   1. OAuth token
//!   2. One payout          (needs SPIKE_RECEIVER = a sandbox *personal* account email)
//!   3. Authorize -> capture (prints a link: log in as the sandbox buyer, approve, press Enter)
//!   4. Webhook verification endpoint reachable (with dummy headers it must answer FAILURE)
//!
//! Usage (PowerShell):
//!   $env:PAYPAL_CLIENT_ID="..."; $env:PAYPAL_SECRET="..."; $env:SPIKE_RECEIVER="sb-buyer@personal.example.com"
//!   cargo run --bin cosign-spike
//! Set SPIKE_SKIP_ORDER=1 to skip the interactive step 3.

use cosign_core::paypal::{PayPalClient, PayPalConfig, PayoutRequest, WebhookHeaders};
use std::io::BufRead;

#[tokio::main]
async fn main() {
    let Some(mut cfg) = PayPalConfig::from_env() else {
        eprintln!("Set PAYPAL_CLIENT_ID and PAYPAL_SECRET (sandbox REST app credentials).");
        std::process::exit(2);
    };
    if cfg.webhook_id.is_none() {
        cfg.webhook_id = Some("WH-DUMMY-SPIKE".into());
    }
    println!("PayPal base URL: {}\n", cfg.base_url);
    let client = PayPalClient::new(cfg);
    let mut failures = 0;
    let mut report = |step: &str, r: Result<String, String>| match r {
        Ok(msg) => println!("PASS  {step}: {msg}"),
        Err(msg) => {
            failures += 1;
            println!("FAIL  {step}: {msg}");
        }
    };

    // 1. Token
    let token = client.access_token().await;
    report("1. OAuth token", token.as_ref().map(|t| format!("{}... ({} chars)", &t[..8.min(t.len())], t.len())).map_err(|e| e.to_string()));
    if token.is_err() {
        std::process::exit(1);
    }

    // 2. Payout
    match std::env::var("SPIKE_RECEIVER") {
        Ok(receiver) if !receiver.is_empty() => {
            let batch = uuid::Uuid::new_v4().to_string();
            let item = uuid::Uuid::new_v4().to_string();
            let req = PayoutRequest { sender_batch_id: &batch, sender_item_id: &item, receiver_email: &receiver, value: "1.00", currency: "USD", note: "Cosign spike payout" };
            let r = client.create_payout(&req).await;
            report("2. Payout", r.as_ref().map(|p| format!("batch {} status {}", p.payout_batch_id, p.batch_status)).map_err(|e| e.to_string()));
            // Same batch ID again must not pay twice.
            let again = client.create_payout(&req).await;
            report(
                "2b. Payout replay is rejected",
                match again {
                    Ok(p) => Err(format!("second call returned batch {} — check PayPal's duplicate handling", p.payout_batch_id)),
                    Err(e) => Ok(format!("refused as expected: {}", truncate(&e.to_string(), 160))),
                },
            );
        }
        _ => report("2. Payout", Err("skipped: set SPIKE_RECEIVER to a sandbox personal account email".into())),
    }

    // 3. Authorize -> capture
    if std::env::var("SPIKE_SKIP_ORDER").is_ok() {
        println!("SKIP  3. Authorize -> capture (SPIKE_SKIP_ORDER set)");
    } else {
        let rid = uuid::Uuid::new_v4().to_string();
        match client.create_authorize_order("5.00", "USD", "spike-milestone", &rid).await {
            Ok(order) => {
                println!("\n      Open this link, log in as a sandbox BUYER and approve:\n      {}\n      Then press Enter.", order.approve_url.clone().unwrap_or_else(|| "(no approve link returned)".into()));
                let _ = std::io::stdin().lock().lines().next();
                match client.authorize_order(&order.id, &uuid::Uuid::new_v4().to_string()).await {
                    Ok(auth) => {
                        report("3a. Authorize", Ok(format!("authorization {} status {} expires {:?}", auth.id, auth.status, auth.expiration_time)));
                        let cap = client.capture_authorization(&auth.id, &uuid::Uuid::new_v4().to_string()).await;
                        report(
                            "3b. Capture",
                            cap.map(|v| format!("capture {} status {}", v["id"].as_str().unwrap_or("?"), v["status"].as_str().unwrap_or("?"))).map_err(|e| e.to_string()),
                        );
                    }
                    Err(e) => report("3a. Authorize", Err(e.to_string())),
                }
            }
            Err(e) => report("3. Create AUTHORIZE order", Err(e.to_string())),
        }
    }

    // 4. Webhook verification endpoint
    let headers = WebhookHeaders {
        auth_algo: "SHA256withRSA".into(),
        cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77".into(),
        transmission_id: uuid::Uuid::new_v4().to_string(),
        transmission_sig: "invalid".into(),
        transmission_time: chrono::Utc::now().to_rfc3339(),
    };
    let body = r#"{"id":"WH-SPIKE","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{}}"#;
    report(
        "4. Webhook verification endpoint",
        match client.verify_webhook(&headers, body).await {
            Ok(false) => Ok("reachable; forged event correctly reported as not verified".into()),
            Ok(true) => Err("a forged event verified — do not ship until this is understood".into()),
            Err(e) => Err(e.to_string()),
        },
    );

    println!("\n{}", if failures == 0 { "GATE: PASS — keep the executor in Rust." } else { "GATE: FAIL — see the blueprint's fallback (Python treasury service) if these cannot be fixed by Oct 18." });
    std::process::exit(if failures == 0 { 0 } else { 1 });
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}...", &s[..s.char_indices().take_while(|(i, _)| *i < n).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(0)]) }
}
