//! Money as integer minor units. Floats never touch an amount.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Money {
    /// Minor units (cents). Always non-negative for payments.
    pub cents: i64,
    /// ISO 4217 code, upper case.
    pub currency: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MoneyError {
    #[error("amount is not a decimal number: {0:?}")]
    NotDecimal(String),
    #[error("amount has more than two decimal places: {0:?}")]
    TooPrecise(String),
    #[error("amount must be greater than zero")]
    NotPositive,
    #[error("amount is too large")]
    TooLarge,
    #[error("currency must be a three-letter ISO code: {0:?}")]
    BadCurrency(String),
}

impl Money {
    /// Parses PayPal-style decimal strings such as "1250.00" or "12.5".
    pub fn parse(amount: &str, currency: &str) -> Result<Self, MoneyError> {
        let currency = currency.trim().to_ascii_uppercase();
        if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(MoneyError::BadCurrency(currency));
        }
        let s = amount.trim().replace(',', "");
        let (whole, frac) = match s.split_once('.') {
            Some((w, f)) => (w, f),
            None => (s.as_str(), ""),
        };
        if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return Err(MoneyError::NotDecimal(amount.to_string()));
        }
        if frac.len() > 2 {
            return Err(MoneyError::TooPrecise(amount.to_string()));
        }
        let whole: i64 = whole.parse().map_err(|_| MoneyError::TooLarge)?;
        let frac_cents: i64 = match frac.len() {
            0 => 0,
            1 => frac.parse::<i64>().unwrap() * 10,
            _ => frac.parse::<i64>().unwrap(),
        };
        let cents = whole.checked_mul(100).and_then(|c| c.checked_add(frac_cents)).ok_or(MoneyError::TooLarge)?;
        if cents <= 0 {
            return Err(MoneyError::NotPositive);
        }
        Ok(Money { cents, currency })
    }

    /// The decimal string PayPal expects, e.g. "1250.00".
    pub fn to_paypal_value(&self) -> String {
        format!("{}.{:02}", self.cents / 100, self.cents % 100)
    }
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.to_paypal_value(), self.currency)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_forms() {
        assert_eq!(Money::parse("1250.00", "usd").unwrap().cents, 125_000);
        assert_eq!(Money::parse("12.5", "USD").unwrap().cents, 1_250);
        assert_eq!(Money::parse("7", "USD").unwrap().cents, 700);
        assert_eq!(Money::parse("1,000.10", "USD").unwrap().cents, 100_010);
    }

    #[test]
    fn rejects_bad_amounts() {
        assert!(matches!(Money::parse("1.234", "USD"), Err(MoneyError::TooPrecise(_))));
        assert!(matches!(Money::parse("-5", "USD"), Err(MoneyError::NotDecimal(_))));
        assert!(matches!(Money::parse("0.00", "USD"), Err(MoneyError::NotPositive)));
        assert!(matches!(Money::parse("abc", "USD"), Err(MoneyError::NotDecimal(_))));
        assert!(matches!(Money::parse("1e5", "USD"), Err(MoneyError::NotDecimal(_))));
        assert!(matches!(Money::parse("10", "US"), Err(MoneyError::BadCurrency(_))));
        assert!(matches!(Money::parse("99999999999999999999", "USD"), Err(MoneyError::TooLarge)));
    }

    #[test]
    fn round_trips_to_paypal_value() {
        for s in ["0.01", "1.00", "1250.75", "100000.10"] {
            assert_eq!(Money::parse(s, "USD").unwrap().to_paypal_value(), s);
        }
    }
}
