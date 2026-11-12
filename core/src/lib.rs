//! Cosign core. The only process that decides, records and moves money.

pub mod api;
pub mod audit;
pub mod executor;
pub mod milestones;
pub mod money;
pub mod paypal;
pub mod policy;
pub mod service;
pub mod similarity;
pub mod state;

use executor::{Backend, PayPalExecutor};
use paypal::{PayPalClient, PayPalConfig};
use service::AppState;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Clone)]
pub struct Settings {
    pub database_url: String,
    pub agent_token: String,
    pub operator_token: String,
    pub internal_token: Option<String>,
    pub default_owner: String,
    pub paypal: Option<PayPalConfig>,
}

impl Settings {
    pub fn from_env() -> anyhow::Result<Self> {
        let required = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty()).ok_or_else(|| anyhow::anyhow!("{k} must be set"));
        let agent_token = required("CORE_AGENT_TOKEN")?;
        let operator_token = required("CORE_OPERATOR_TOKEN")?;
        anyhow::ensure!(agent_token != operator_token, "CORE_AGENT_TOKEN and CORE_OPERATOR_TOKEN must differ");
        anyhow::ensure!(agent_token.len() >= 16 && operator_token.len() >= 16, "tokens must be at least 16 characters");
        Ok(Settings {
            database_url: required("DATABASE_URL")?,
            agent_token,
            operator_token,
            internal_token: std::env::var("CORE_INTERNAL_TOKEN").ok().filter(|t| t.len() >= 16),
            default_owner: std::env::var("COSIGN_OWNER").unwrap_or_else(|_| "demo".into()),
            paypal: PayPalConfig::from_env(),
        })
    }
}

pub async fn build_state(settings: &Settings) -> anyhow::Result<AppState> {
    let pool = PgPoolOptions::new().max_connections(10).connect(&settings.database_url).await?;
    MIGRATOR.run(&pool).await?;
    let paypal = settings.paypal.clone().map(|cfg| Arc::new(PayPalClient::new(cfg)));
    let backend = match &paypal {
        Some(c) => Backend::Live(c.clone()),
        None => Backend::Simulated,
    };
    Ok(AppState {
        pool,
        executor: PayPalExecutor::new(backend),
        paypal,
        agent_token: settings.agent_token.clone(),
        operator_token: settings.operator_token.clone(),
        internal_token: settings.internal_token.clone(),
        default_owner: settings.default_owner.clone(),
    })
}
