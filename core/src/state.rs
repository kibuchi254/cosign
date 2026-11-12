//! Payment and milestone state machines. Every transition goes through `next`, which
//! rejects anything not drawn in the blueprint. The caller writes the audit entry for the
//! transition in the same database transaction.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PaymentState {
    Proposed,
    Allowed,
    NeedsApproval,
    Blocked,
    Approved,
    Denied,
    Submitted,
    Paid,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PaymentEvent {
    DecidedAllow,
    DecidedRequireApproval,
    DecidedBlock,
    Approve,
    Deny,
    Submit,
    ConfirmPaid,
    Fail,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("illegal transition: {event:?} from {from:?}")]
pub struct IllegalTransition<S: std::fmt::Debug, E: std::fmt::Debug> {
    pub from: S,
    pub event: E,
}

impl PaymentState {
    pub const ALL: [PaymentState; 9] = [
        Self::Proposed, Self::Allowed, Self::NeedsApproval, Self::Blocked, Self::Approved,
        Self::Denied, Self::Submitted, Self::Paid, Self::Failed,
    ];

    pub fn next(self, event: PaymentEvent) -> Result<Self, IllegalTransition<Self, PaymentEvent>> {
        use PaymentEvent as E;
        use PaymentState as S;
        Ok(match (self, event) {
            (S::Proposed, E::DecidedAllow) => S::Allowed,
            (S::Proposed, E::DecidedRequireApproval) => S::NeedsApproval,
            (S::Proposed, E::DecidedBlock) => S::Blocked,
            (S::NeedsApproval, E::Approve) => S::Approved,
            (S::NeedsApproval, E::Deny) => S::Denied,
            (S::Allowed | S::Approved, E::Submit) => S::Submitted,
            (S::Submitted, E::ConfirmPaid) => S::Paid,
            (S::Submitted, E::Fail) => S::Failed,
            (from, event) => return Err(IllegalTransition { from, event }),
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Blocked | Self::Denied | Self::Paid | Self::Failed)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proposed => "PROPOSED",
            Self::Allowed => "ALLOWED",
            Self::NeedsApproval => "NEEDS_APPROVAL",
            Self::Blocked => "BLOCKED",
            Self::Approved => "APPROVED",
            Self::Denied => "DENIED",
            Self::Submitted => "SUBMITTED",
            Self::Paid => "PAID",
            Self::Failed => "FAILED",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|st| st.as_str() == s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MilestoneState {
    Draft,
    Funded,
    Delivered,
    Verified,
    Released,
    Voided,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MilestoneEvent {
    /// Buyer funds the milestone: a PayPal authorization is placed.
    Fund,
    /// The authorization was renewed; state is unchanged but the new ID is stored.
    Reauthorize,
    Deliver,
    /// The criteria check passed (or the buyer accepted after a hold).
    Verify,
    /// The criteria check failed: back to Funded so the seller can redeliver.
    Reject,
    Release,
    Void,
    Expire,
}

impl MilestoneState {
    pub const ALL: [MilestoneState; 7] =
        [Self::Draft, Self::Funded, Self::Delivered, Self::Verified, Self::Released, Self::Voided, Self::Expired];

    pub fn next(self, event: MilestoneEvent) -> Result<Self, IllegalTransition<Self, MilestoneEvent>> {
        use MilestoneEvent as E;
        use MilestoneState as S;
        Ok(match (self, event) {
            (S::Draft, E::Fund) => S::Funded,
            (s @ (S::Funded | S::Delivered | S::Verified), E::Reauthorize) => s,
            (S::Funded, E::Deliver) => S::Delivered,
            (S::Delivered, E::Verify) => S::Verified,
            (S::Delivered, E::Reject) => S::Funded,
            (S::Verified, E::Release) => S::Released,
            (S::Funded | S::Delivered | S::Verified, E::Void) => S::Voided,
            (S::Funded | S::Delivered | S::Verified, E::Expire) => S::Expired,
            (from, event) => return Err(IllegalTransition { from, event }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYMENT_EVENTS: [PaymentEvent; 8] = [
        PaymentEvent::DecidedAllow, PaymentEvent::DecidedRequireApproval, PaymentEvent::DecidedBlock,
        PaymentEvent::Approve, PaymentEvent::Deny, PaymentEvent::Submit, PaymentEvent::ConfirmPaid, PaymentEvent::Fail,
    ];

    #[test]
    fn every_payment_transition_matches_the_blueprint() {
        use PaymentEvent as E;
        use PaymentState as S;
        let legal = [
            (S::Proposed, E::DecidedAllow, S::Allowed),
            (S::Proposed, E::DecidedRequireApproval, S::NeedsApproval),
            (S::Proposed, E::DecidedBlock, S::Blocked),
            (S::NeedsApproval, E::Approve, S::Approved),
            (S::NeedsApproval, E::Deny, S::Denied),
            (S::Allowed, E::Submit, S::Submitted),
            (S::Approved, E::Submit, S::Submitted),
            (S::Submitted, E::ConfirmPaid, S::Paid),
            (S::Submitted, E::Fail, S::Failed),
        ];
        for from in S::ALL {
            for event in PAYMENT_EVENTS {
                let expected = legal.iter().find(|(f, e, _)| *f == from && *e == event).map(|(_, _, t)| *t);
                assert_eq!(from.next(event).ok(), expected, "{from:?} --{event:?}");
            }
        }
    }

    #[test]
    fn blocked_and_needs_approval_can_never_submit() {
        assert!(PaymentState::Blocked.next(PaymentEvent::Submit).is_err());
        assert!(PaymentState::NeedsApproval.next(PaymentEvent::Submit).is_err());
        assert!(PaymentState::Denied.next(PaymentEvent::Approve).is_err());
        assert!(PaymentState::Blocked.next(PaymentEvent::Approve).is_err());
    }

    #[test]
    fn terminal_states_have_no_exits() {
        for s in PaymentState::ALL.into_iter().filter(|s| s.is_terminal()) {
            for e in PAYMENT_EVENTS {
                assert!(s.next(e).is_err(), "{s:?} --{e:?}");
            }
        }
    }

    #[test]
    fn state_strings_round_trip() {
        for s in PaymentState::ALL {
            assert_eq!(PaymentState::parse(s.as_str()), Some(s));
        }
    }

    #[test]
    fn milestone_transitions() {
        use MilestoneEvent as E;
        use MilestoneState as S;
        let events = [E::Fund, E::Reauthorize, E::Deliver, E::Verify, E::Reject, E::Release, E::Void, E::Expire];
        let legal = [
            (S::Draft, E::Fund, S::Funded),
            (S::Funded, E::Reauthorize, S::Funded),
            (S::Delivered, E::Reauthorize, S::Delivered),
            (S::Verified, E::Reauthorize, S::Verified),
            (S::Funded, E::Deliver, S::Delivered),
            (S::Delivered, E::Verify, S::Verified),
            (S::Delivered, E::Reject, S::Funded),
            (S::Verified, E::Release, S::Released),
            (S::Funded, E::Void, S::Voided),
            (S::Delivered, E::Void, S::Voided),
            (S::Verified, E::Void, S::Voided),
            (S::Funded, E::Expire, S::Expired),
            (S::Delivered, E::Expire, S::Expired),
            (S::Verified, E::Expire, S::Expired),
        ];
        for from in S::ALL {
            for event in events {
                let expected = legal.iter().find(|(f, e, _)| *f == from && *e == event).map(|(_, _, t)| *t);
                assert_eq!(from.next(event).ok(), expected, "{from:?} --{event:?}");
            }
        }
    }
}
