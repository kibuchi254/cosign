// Response shapes of the Rust core (core/openapi.json) and the Python agent, as the web app uses them.

export type ReasonCode =
  | 'VENDOR_UNKNOWN'
  | 'PAYOUT_DETAILS_CHANGED'
  | 'OVER_INVOICE_CAP'
  | 'OVER_DAILY_CAP'
  | 'MANDATE_EXPIRED'
  | 'DUPLICATE_INVOICE'
  | 'VELOCITY'
  | 'DUE_DATE_IMPLAUSIBLE'
  | 'INJECTION_SUSPECTED'
  | 'CRITERIA_FAILED'
  | 'UNREADABLE_DOCUMENT'
  | 'AI_FLAGGED';

export type Reason = { code: ReasonCode; detail: string; source: 'rule' | 'agent' };
export type Flag = { code: string; detail: string };
export type Outcome = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK';
export type PaymentState =
  | 'PROPOSED'
  | 'ALLOWED'
  | 'NEEDS_APPROVAL'
  | 'BLOCKED'
  | 'APPROVED'
  | 'DENIED'
  | 'SUBMITTED'
  | 'PAID'
  | 'FAILED';

export type MandateRules = {
  currency: string;
  per_invoice_cap_cents: number;
  daily_cap_cents: number;
  velocity_max_payments: number;
  velocity_window_minutes: number;
  due_date_max_past_days: number;
  due_date_max_future_days: number;
};

export type Mandate = {
  id: string;
  owner_id: string;
  rules: MandateRules;
  hash: string;
  expires_at: string;
  created_at: string;
};

export type LedgerPayment = {
  payment_id: string;
  invoice_id: string;
  vendor_name: string;
  vendor_known: boolean;
  invoice_number: string;
  amount: string;
  amount_cents: number;
  currency: string;
  due_date: string | null;
  receiver_email: string;
  decision: Outcome;
  reasons: Reason[];
  agent_flags: Flag[];
  state: PaymentState;
  decision_hash: string;
  mandate_hash: string;
  payout_ref: string | null;
  failure: string | null;
  created_at: string;
  updated_at: string;
};

export type VerifyReport = {
  ok: boolean;
  entries: number;
  head_hash: string;
  first_broken_seq: number | null;
  problem: string | null;
};

export type Ledger = {
  as_of: string;
  simulation: boolean;
  mandate: Mandate | null;
  totals: {
    paid_cents: number;
    in_flight_cents: number;
    awaiting_approval_cents: number;
    blocked_cents: number;
    counts: Record<'paid' | 'submitted' | 'needs_approval' | 'blocked' | 'denied' | 'failed', number>;
  };
  payments: LedgerPayment[];
  audit: VerifyReport;
};

export type DecisionResponse = {
  payment_id: string;
  invoice_id: string;
  decision: Outcome;
  reasons: Reason[];
  state: PaymentState;
  decision_hash: string;
  mandate_id: string;
  mandate_hash: string;
  payout_ref: string | null;
  execution: string | null;
};

export type Vendor = { id: string; name: string; paypal_email: string; verified_at: string };

export type MilestoneState = 'DRAFT' | 'FUNDED' | 'DELIVERED' | 'VERIFIED' | 'RELEASED' | 'VOIDED' | 'EXPIRED';

export type CriterionResult = { criterion: string; passed: boolean; reason: string; confidence: number };

export type Milestone = {
  id: string;
  deal_id: string;
  seq: number;
  title: string;
  amount: string;
  amount_cents: number;
  currency: string;
  criteria: string[];
  state: MilestoneState;
  paypal_order_id: string | null;
  approve_url: string | null;
  authorization_id: string | null;
  authorized_at: string | null;
  auth_expires_at: string | null;
  reauthorized_count: number;
  evidence: { text: string; links: string[] } | null;
  evidence_hash: string | null;
  criteria_result: { results: CriterionResult[]; flags: Flag[]; decision: Outcome } | null;
  hold_reasons: Reason[];
  buyer_accepted_hold: boolean;
  capture_id: string | null;
  payout_ref: string | null;
  failure: string | null;
  blocked_by: string | null;
  updated_at: string;
};

export type Deal = {
  id: string;
  owner_id: string;
  title: string;
  buyer: string;
  seller: string;
  seller_email: string;
  created_at: string;
  total_cents: number;
  held_cents: number;
  released_cents: number;
  milestones: Milestone[];
};

export type AuditEntry = {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

export type InvoiceFields = {
  vendor_name: string;
  invoice_number: string;
  amount: string;
  currency: string;
  due_date: string | null;
  payout_email: string;
  suspicious_instructions: string[];
};

export type ReadInvoiceResponse = {
  status: 'proposed' | 'extracted' | 'unreadable';
  source_hash: string;
  fields: InvoiceFields | null;
  flags: Flag[];
  extractor: string;
  decision: DecisionResponse | null;
  error: string | null;
};

export type Review = { summary: string; recommendation: 'approve' | 'deny' | 'investigate'; reviewer: string };
