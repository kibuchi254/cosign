//! Append-only, hash-chained audit log. Each entry's hash covers the previous entry's hash,
//! so editing, deleting or reordering any row breaks every hash after it.

use chrono::{DateTime, SubsecRound, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Row};

use crate::policy::sha256_hex;

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// The hash of one entry. `serde_json` writes object keys in sorted order, so the payload
/// hashes the same after a round trip through Postgres `jsonb`.
pub fn entry_hash(prev_hash: &str, seq: i64, ts: DateTime<Utc>, kind: &str, payload: &Value) -> String {
    let material = format!("{prev_hash}|{seq}|{}|{kind}|{payload}", ts.timestamp_micros());
    sha256_hex(material.as_bytes())
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub seq: i64,
    pub ts: DateTime<Utc>,
    pub kind: String,
    pub payload: Value,
    pub prev_hash: String,
    pub hash: String,
}

/// Appends an entry inside the caller's transaction. A transaction-scoped advisory lock
/// serializes writers so two transactions can never chain off the same head.
pub async fn append(conn: &mut PgConnection, kind: &str, payload: Value) -> sqlx::Result<AuditEntry> {
    sqlx::query("SELECT pg_advisory_xact_lock(7244001)").execute(&mut *conn).await?;
    let head = sqlx::query("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
        .fetch_optional(&mut *conn)
        .await?;
    let (seq, prev_hash) = match head {
        Some(row) => (row.get::<i64, _>("seq") + 1, row.get::<String, _>("hash")),
        None => (1, GENESIS_HASH.to_string()),
    };
    // Postgres keeps microseconds; truncate first so the stored value hashes identically.
    let ts = Utc::now().trunc_subsecs(6);
    let hash = entry_hash(&prev_hash, seq, ts, kind, &payload);
    sqlx::query("INSERT INTO audit_log (seq, ts, kind, payload_json, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(seq)
        .bind(ts)
        .bind(kind)
        .bind(&payload)
        .bind(&prev_hash)
        .bind(&hash)
        .execute(&mut *conn)
        .await?;
    Ok(AuditEntry { seq, ts, kind: kind.to_string(), payload, prev_hash, hash })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VerifyReport {
    pub ok: bool,
    pub entries: i64,
    pub head_hash: String,
    /// The first sequence number whose hash, link or position is wrong.
    pub first_broken_seq: Option<i64>,
    pub problem: Option<String>,
}

/// Recomputes the chain from rows already loaded in sequence order.
pub fn verify_rows(rows: &[AuditEntry]) -> VerifyReport {
    let mut prev = GENESIS_HASH.to_string();
    for (i, row) in rows.iter().enumerate() {
        let expected_seq = i as i64 + 1;
        let problem = if row.seq != expected_seq {
            Some(format!("expected seq {expected_seq}, found {} (a row is missing or out of order)", row.seq))
        } else if row.prev_hash != prev {
            Some("prev_hash does not match the previous entry".to_string())
        } else if entry_hash(&row.prev_hash, row.seq, row.ts, &row.kind, &row.payload) != row.hash {
            Some("hash does not match the entry's contents".to_string())
        } else {
            None
        };
        if let Some(problem) = problem {
            return VerifyReport { ok: false, entries: rows.len() as i64, head_hash: prev, first_broken_seq: Some(expected_seq), problem: Some(problem) };
        }
        prev = row.hash.clone();
    }
    VerifyReport { ok: true, entries: rows.len() as i64, head_hash: prev, first_broken_seq: None, problem: None }
}

pub async fn load_all(pool: &PgPool) -> sqlx::Result<Vec<AuditEntry>> {
    let rows = sqlx::query("SELECT seq, ts, kind, payload_json, prev_hash, hash FROM audit_log ORDER BY seq")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| AuditEntry {
            seq: r.get("seq"),
            ts: r.get("ts"),
            kind: r.get("kind"),
            payload: r.get("payload_json"),
            prev_hash: r.get("prev_hash"),
            hash: r.get("hash"),
        })
        .collect())
}

pub async fn verify(pool: &PgPool) -> sqlx::Result<VerifyReport> {
    Ok(verify_rows(&load_all(pool).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use proptest::prelude::*;
    use serde_json::json;

    fn chain(payloads: &[Value]) -> Vec<AuditEntry> {
        let mut prev = GENESIS_HASH.to_string();
        let mut out = Vec::new();
        for (i, p) in payloads.iter().enumerate() {
            let seq = i as i64 + 1;
            let ts = Utc.timestamp_micros(1_792_000_000_000_000 + seq * 1_000).unwrap();
            let hash = entry_hash(&prev, seq, ts, "test", p);
            out.push(AuditEntry { seq, ts, kind: "test".into(), payload: p.clone(), prev_hash: prev.clone(), hash: hash.clone() });
            prev = hash;
        }
        out
    }

    #[test]
    fn intact_chain_verifies() {
        let rows = chain(&[json!({"a": 1}), json!({"b": [1, 2]}), json!({})]);
        let r = verify_rows(&rows);
        assert!(r.ok);
        assert_eq!(r.head_hash, rows[2].hash);
        assert!(verify_rows(&[]).ok);
    }

    #[test]
    fn key_order_does_not_change_the_hash() {
        let a: Value = serde_json::from_str(r#"{"z": 1, "a": {"y": 2, "b": 3}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a": {"b": 3, "y": 2}, "z": 1}"#).unwrap();
        let ts = Utc::now();
        assert_eq!(entry_hash("p", 1, ts, "k", &a), entry_hash("p", 1, ts, "k", &b));
    }

    #[test]
    fn deleted_row_is_detected() {
        let mut rows = chain(&[json!(1), json!(2), json!(3)]);
        rows.remove(1);
        let r = verify_rows(&rows);
        assert_eq!(r.first_broken_seq, Some(2));
    }

    proptest! {
        // Invariant from the blueprint: a tampered audit entry always fails verification.
        #[test]
        fn any_tampering_fails_verification(
            values in prop::collection::vec(any::<i64>(), 1..20),
            target in any::<prop::sample::Index>(),
            field in 0u8..5,
            new_value in any::<i64>(),
        ) {
            let payloads: Vec<Value> = values.iter().map(|v| json!({"v": v})).collect();
            let mut rows = chain(&payloads);
            let i = target.index(rows.len());
            let row = &mut rows[i];
            let changed = match field {
                0 => { let n = json!({"v": new_value}); let c = n != row.payload; row.payload = n; c }
                1 => { row.kind.push('x'); true }
                2 => { row.ts += chrono::Duration::microseconds(1); true }
                3 => { row.hash = sha256_hex(row.hash.as_bytes()); true }
                _ => { row.prev_hash = sha256_hex(row.prev_hash.as_bytes()); true }
            };
            prop_assume!(changed);
            let report = verify_rows(&rows);
            prop_assert!(!report.ok);
            prop_assert_eq!(report.first_broken_seq, Some(i as i64 + 1));
        }
    }
}
