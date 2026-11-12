use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "cosign_core=info,tower_http=info".into()))
        .init();

    let settings = cosign_core::Settings::from_env()?;
    let state = cosign_core::build_state(&settings).await?;
    match &settings.paypal {
        Some(cfg) => tracing::info!(base_url = %cfg.base_url, webhooks = cfg.webhook_id.is_some(), "PayPal live mode"),
        None => tracing::warn!("PAYPAL_CLIENT_ID/PAYPAL_SECRET not set: payouts are simulated and webhooks are refused"),
    }

    // Follow PayPal payout outcomes without depending on a public webhook URL.
    if state.paypal.is_some() {
        let poll_state = state.clone();
        let secs: u64 = std::env::var("PAYOUT_POLL_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(20);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(secs.max(5)));
            loop {
                tick.tick().await;
                if let Err(e) = cosign_core::service::reconcile_payouts(&poll_state).await {
                    tracing::warn!(error = %e, "payout status poll failed");
                }
            }
        });
    }

    let cors = match std::env::var("CORS_ALLOW_ORIGIN") {
        Ok(origin) if !origin.is_empty() => CorsLayer::new()
            .allow_origin(origin.parse::<axum::http::HeaderValue>()?)
            .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
            .allow_headers([axum::http::header::AUTHORIZATION, axum::http::header::CONTENT_TYPE]),
        _ => CorsLayer::new(),
    };
    let app = cosign_core::api::router(state).layer(cors).layer(TraceLayer::new_for_http());

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    tracing::info!(%port, "cosign core listening");
    axum::serve(listener, app).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await?;
    Ok(())
}
