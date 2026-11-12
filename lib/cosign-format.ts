// Display helpers shared by server and client components. Plain language for every code the
// core returns, so the UI never shows a raw enum to a person.

import type { AuditEntry, LedgerPayment, MilestoneState, Outcome, PaymentState, ReasonCode } from './cosign-types';

export const money = (cents: number, currency = 'USD') =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2 });

export const moneyStr = (amount: string, currency = 'USD') => money(Math.round(Number(amount) * 100), currency);

export const shortHash = (h: string | null | undefined, n = 10) => (h ? h.replace(/^sha256:/, '').slice(0, n) : '');

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '';

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

export const REASON_LABEL: Record<ReasonCode, string> = {
  VENDOR_UNKNOWN: 'Vendor not on your approved list',
  PAYOUT_DETAILS_CHANGED: 'Payout email differs from the vendor record',
  OVER_INVOICE_CAP: 'Above your per-invoice limit',
  OVER_DAILY_CAP: 'Would pass your daily limit',
  MANDATE_EXPIRED: 'Your mandate has expired',
  DUPLICATE_INVOICE: 'Invoice number already used',
  VELOCITY: 'Too many payments in a short time',
  DUE_DATE_IMPLAUSIBLE: 'Due date missing or far from today',
  INJECTION_SUSPECTED: 'Document tries to instruct the AI',
  CRITERIA_FAILED: 'Acceptance criteria not met',
  UNREADABLE_DOCUMENT: 'Document could not be read reliably',
  AI_FLAGGED: 'Agent noticed something unusual',
};

export type Tone = 'cleared' | 'held' | 'blocked' | 'neutral' | 'sign';

export const OUTCOME: Record<Outcome, { stamp: string; tone: Tone; sentence: string }> = {
  ALLOW: { stamp: 'Paid', tone: 'cleared', sentence: 'Inside your limits, so Cosign paid it.' },
  REQUIRE_APPROVAL: { stamp: 'Held', tone: 'held', sentence: 'Waiting for your signature.' },
  BLOCK: { stamp: 'Blocked', tone: 'blocked', sentence: 'Blocked. Nobody can approve this payment.' },
};

export const PAYMENT_STATE: Record<PaymentState, { label: string; tone: Tone }> = {
  PROPOSED: { label: 'Proposed', tone: 'neutral' },
  ALLOWED: { label: 'Allowed', tone: 'cleared' },
  NEEDS_APPROVAL: { label: 'Needs your signature', tone: 'held' },
  BLOCKED: { label: 'Blocked', tone: 'blocked' },
  APPROVED: { label: 'Approved', tone: 'cleared' },
  DENIED: { label: 'Denied', tone: 'neutral' },
  SUBMITTED: { label: 'Sent to PayPal', tone: 'sign' },
  PAID: { label: 'Paid', tone: 'cleared' },
  FAILED: { label: 'Failed', tone: 'blocked' },
};

export const MILESTONE_STATE: Record<MilestoneState, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Not funded', tone: 'neutral' },
  FUNDED: { label: 'Funds held', tone: 'sign' },
  DELIVERED: { label: 'Delivered', tone: 'held' },
  VERIFIED: { label: 'Verified', tone: 'cleared' },
  RELEASED: { label: 'Released', tone: 'cleared' },
  VOIDED: { label: 'Voided', tone: 'neutral' },
  EXPIRED: { label: 'Hold expired', tone: 'blocked' },
};

export const AUDIT_KIND: Record<string, string> = {
  'mandate.created': 'Mandate signed',
  'vendor.created': 'Vendor approved',
  'payment.decided': 'Payment decided',
  'payment.submitted': 'Sent to PayPal',
  'payment.payout_accepted': 'PayPal accepted payout',
  'payment.paid': 'Payment settled',
  'payment.failed': 'Payment failed',
  'payment.outcome_unknown': 'Payout outcome unknown',
  'payment.retried': 'Payment retried',
  'approval.recorded': 'Human decision',
  'webhook.received': 'PayPal webhook',
  'deal.created': 'Deal created',
  'milestone.order_created': 'Funding order created',
  'milestone.funded': 'Milestone funded',
  'milestone.delivered': 'Work delivered',
  'milestone.verified': 'Milestone verified',
  'milestone.held': 'Delivery held',
  'milestone.rejected': 'Delivery rejected',
  'milestone.released': 'Funds released',
  'milestone.release_failed': 'Release failed',
  'milestone.voided': 'Milestone voided',
  'milestone.expired': 'Hold expired',
  'milestone.reauthorized': 'Hold renewed',
  'agent.read_token_issued': 'Agent read token issued',
};

/** The stamp for a payment as it stands now, not only as first decided. */
export function paymentStamp(p: Pick<LedgerPayment, 'decision' | 'state'>): { tone: Tone; label: string; sub?: string } {
  switch (p.state) {
    case 'PAID':
      return { tone: 'cleared', label: 'Paid', sub: p.decision === 'ALLOW' ? 'automatically' : 'signed by you' };
    case 'SUBMITTED':
      return { tone: 'sign', label: 'Sent', sub: 'to PayPal' };
    case 'DENIED':
      return { tone: 'neutral', label: 'Denied' };
    case 'FAILED':
      return { tone: 'blocked', label: 'Failed' };
    case 'BLOCKED':
      return { tone: 'blocked', label: 'Blocked' };
    case 'NEEDS_APPROVAL':
      return { tone: 'held', label: 'Held' };
    default:
      return { tone: OUTCOME[p.decision].tone, label: OUTCOME[p.decision].stamp };
  }
}

/** "5 min ago", "yesterday", "12 Oct". Use in server components (it reads the clock). */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172_800) return 'yesterday';
  return day(iso);
}

const stateLabel = (v: string) =>
  (PAYMENT_STATE as Record<string, { label: string }>)[v]?.label ?? (MILESTONE_STATE as Record<string, { label: string }>)[v]?.label ?? v;

/** One line of plain language for an audit entry. */
export function auditDetail(e: AuditEntry): string {
  const p = e.payload as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const n = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0);
  switch (e.kind) {
    case 'payment.decided':
      return `${s('vendor_name')} #${s('invoice_number')}: ${(OUTCOME as Record<string, { stamp: string }>)[s('outcome')]?.stamp ?? s('outcome')}${n('reasons') ? `, ${n('reasons')} reason${n('reasons') > 1 ? 's' : ''}` : ''}`;
    case 'payment.paid':
    case 'payment.payout_accepted':
      return `PayPal reference ${s('payout_ref')}`;
    case 'milestone.held':
      return `${n('reasons')} reason${n('reasons') === 1 ? '' : 's'} to hold`;
    case 'milestone.released':
      return `Payout ${s('payout_ref')}`;
    case 'mandate.created':
      return `Mandate ${s('hash').slice(0, 12)}`;
    case 'approval.recorded':
      return `${s('approver')} ${s('verdict') === 'approve' ? 'approved' : 'denied'}${s('note') ? `: ${s('note')}` : ''}`;
    case 'vendor.created':
      return s('name');
    case 'deal.created':
      return `${s('title')} with ${s('seller')}`;
    case 'webhook.received':
      return s('event_type');
    case 'payment.submitted':
      return 'Payout request sent with its idempotency key';
    case 'milestone.funded':
      return `PayPal hold ${s('authorization_id')}`;
    case 'milestone.delivered':
      return `Evidence ${s('evidence_hash').replace('sha256:', '').slice(0, 12)}`;
    case 'milestone.verified':
      return (p.by as string) === 'buyer' ? `Accepted by ${s('approver')}` : 'Every criterion passed the check';
    case 'milestone.rejected':
      return `Sent back by ${s('approver')}${s('note') ? `: ${s('note')}` : ''}`;
    case 'milestone.voided':
      return 'Hold cancelled';
    case 'milestone.reauthorized':
      return `New hold ${s('authorization_id')}`;
    default:
      return [s('from') && s('to') ? `${stateLabel(s('from'))} to ${stateLabel(s('to'))}` : '', s('error')].filter(Boolean).join(', ');
  }
}

/** The tone an audit entry is shown in. */
export function auditTone(e: AuditEntry): Tone {
  const outcome = (e.payload as { outcome?: string }).outcome;
  if (e.kind === 'payment.decided') return outcome === 'ALLOW' ? 'cleared' : outcome === 'BLOCK' ? 'blocked' : 'held';
  if (/paid|released|verified|funded|vendor|mandate/.test(e.kind)) return 'cleared';
  if (/failed|expired|voided|rejected/.test(e.kind)) return 'blocked';
  if (/held|unknown/.test(e.kind)) return 'held';
  if (e.kind === 'approval.recorded') return (e.payload as { verdict?: string }).verdict === 'approve' ? 'cleared' : 'neutral';
  return 'sign';
}
