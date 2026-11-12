// Server-side clients for the Rust core and the Python agent. The operator token stays on the
// server: pages and server actions call these, and the browser never sees either token.
import 'server-only';

import type {
  AuditEntry,
  Deal,
  DecisionResponse,
  Ledger,
  Mandate,
  MandateRules,
  Milestone,
  ReadInvoiceResponse,
  Review,
  Vendor,
  VerifyReport,
} from './cosign-types';

// Accepts a full URL or a bare host:port (what Render's private network hands out).
const base = (v: string | undefined, fallback: string) => {
  const u = (v || fallback).replace(/\/$/, '');
  return /^https?:\/\//.test(u) ? u : `http://${u}`;
};
const coreUrl = () => base(process.env.COSIGN_CORE_URL, 'http://localhost:8080');
const agentUrl = () => base(process.env.COSIGN_AGENT_URL, 'http://localhost:8000');

import { CosignError } from './cosign-error';

export { CosignError };

async function call<T>(base: string, path: string, token: string | undefined, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    throw new CosignError(503, `Cannot reach ${base}. Is the service running?`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const j = JSON.parse(text);
      message = j.message ?? j.detail ?? text;
    } catch {}
    throw new CosignError(res.status, typeof message === 'string' ? message : JSON.stringify(message));
  }
  return (text ? JSON.parse(text) : null) as T;
}

const operator = () => {
  const t = process.env.CORE_OPERATOR_TOKEN;
  if (!t) throw new CosignError(500, 'CORE_OPERATOR_TOKEN is not set for the web app (see env.example).');
  return t;
};
// async, so a missing token becomes a rejected promise the pages can catch and explain.
const core = async <T,>(path: string, init?: { method?: string; body?: unknown }) => call<T>(coreUrl(), path, operator(), init);
const agent = <T>(path: string, body: unknown) => call<T>(agentUrl(), path, process.env.AGENT_API_TOKEN, { method: 'POST', body });

// --- Core ---------------------------------------------------------------------------------------

export const getLedger = () => core<Ledger>('/v1/ledger');
export const verifyAudit = () => call<VerifyReport>(coreUrl(), '/v1/audit/verify', undefined);
export const getAudit = (limit = 500) => core<AuditEntry[]>(`/v1/audit?limit=${limit}`);
export const getVendors = () => core<Vendor[]>('/v1/vendors');
export const createVendor = (name: string, paypal_email: string) => core<Vendor>('/v1/vendors', { method: 'POST', body: { name, paypal_email } });
export const getMandate = () => core<Mandate>('/v1/mandates/active');
export const createMandate = (rules: MandateRules, expires_at: string) => core<Mandate>('/v1/mandates', { method: 'POST', body: { rules, expires_at } });
export const health = () => call<{ ok: boolean; paypal: 'live' | 'simulated' }>(coreUrl(), '/healthz', undefined);

export const approvePayment = (paymentId: string, verdict: 'approve' | 'deny', approver: string, decisionHash: string, note?: string) =>
  core<{ state: string; execution: string | null }>(`/v1/approvals/${paymentId}`, {
    method: 'POST',
    body: { verdict, approver, decision_hash: decisionHash, note: note || null },
  });
export const retryPayment = (paymentId: string) => core<DecisionResponse>(`/v1/payments/${paymentId}/retry`, { method: 'POST' });

export const getDeals = () => core<Deal[]>('/v1/deals');
export const createDeal = (body: { title: string; seller: string; seller_email: string; milestones: { title: string; amount: string; currency: string; criteria: string[] }[] }) =>
  core<Deal>('/v1/deals', { method: 'POST', body });
export const fundMilestone = (id: string) => core<{ milestone: Milestone; approve_url: string | null }>(`/v1/milestones/${id}/fund`, { method: 'POST' });
export const confirmFunding = (id: string) => core<Milestone>(`/v1/milestones/${id}/fund/confirm`, { method: 'POST' });
export const deliverMilestone = (id: string, evidence: string, links: string[]) => core<Milestone>(`/v1/milestones/${id}/deliver`, { method: 'POST', body: { evidence, links } });
export const acceptMilestone = (id: string, approver: string, note?: string) => core<Milestone>(`/v1/milestones/${id}/accept`, { method: 'POST', body: { approver, note } });
export const rejectMilestone = (id: string, approver: string, note?: string) => core<Milestone>(`/v1/milestones/${id}/reject`, { method: 'POST', body: { approver, note } });
export const releaseMilestone = (id: string) => core<{ milestone: Milestone; execution: string }>(`/v1/milestones/${id}/release`, { method: 'POST' });
export const voidMilestone = (id: string, approver: string, note?: string) => core<Milestone>(`/v1/milestones/${id}/void`, { method: 'POST', body: { approver, note } });

// --- Agent --------------------------------------------------------------------------------------

export const readInvoice = (input: { text?: string; pdf_base64?: string; image_base64?: string; filename?: string }) => agent<ReadInvoiceResponse>('/agent/read-invoice', { ...input, propose: true });
export const reviewPayment = (p: { vendor_name: string; invoice_number: string; amount: string; currency: string; decision: string; reasons: unknown[]; agent_flags: unknown[] }) =>
  agent<Review>('/agent/review', p);
export const checkMilestone = (m: { milestone_id: string; evidence_hash: string; criteria: string[]; evidence: string }) =>
  agent<{ all_passed: boolean; checker: string; core: { decision: string } | null }>('/agent/check-milestone', { ...m, submit: true });
