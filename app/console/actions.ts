'use server';

// Every write the console makes. Each action checks the session, calls the core or the agent
// with the server-side token, and returns a message for the form (never throws at the user).

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import * as cosign from '@/lib/cosign';
import { CosignError } from '@/lib/cosign';
import { SESSION_COOKIE, verify } from '@/lib/session';
import type { DecisionResponse, MandateRules, ReadInvoiceResponse } from '@/lib/cosign-types';

export type ActionState = { ok: boolean; message: string; warn?: boolean } | null;

async function signer(): Promise<string> {
  const session = await verify((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  return session.name;
}

const fail = (e: unknown): ActionState => ({
  ok: false,
  message: e instanceof CosignError ? e.message : e instanceof Error ? e.message : 'Something went wrong.',
});

const done = (message: string, warn = false): ActionState => {
  revalidatePath('/console', 'layout');
  return { ok: true, message, warn };
};

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

// --- Approvals ----------------------------------------------------------------------------------

export async function decidePayment(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const approver = await signer();
    const verdict = str(form, 'verdict') === 'approve' ? 'approve' : 'deny';
    const note = str(form, 'note');
    if (verdict === 'deny' && !note) return { ok: false, message: 'Say why you are denying it. The reason goes in the audit log.' };
    const r = await cosign.approvePayment(str(form, 'payment_id'), verdict, approver, str(form, 'decision_hash'), note);
    const who = str(form, 'label');
    return done(
      verdict === 'approve'
        ? `${who} ${r.state === 'PAID' ? 'is paid.' : r.state === 'SUBMITTED' ? 'was sent to PayPal.' : `is ${r.state.toLowerCase()}. ${r.execution ?? ''}`}`
        : `${who} was not paid.`,
    );
  } catch (e) {
    return fail(e);
  }
}

/** Approve several payments in one go. Each still quotes its own decision hash. */
export async function approveMany(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const approver = await signer();
    const items = form.getAll('item').map(String);
    if (!items.length) return { ok: false, message: 'Select at least one payment.' };
    const note = str(form, 'note') || 'Approved in bulk';
    let paid = 0;
    const failed: string[] = [];
    for (const it of items) {
      const [id, hash, label] = it.split('|');
      try {
        await cosign.approvePayment(id, 'approve', approver, hash, note);
        paid++;
      } catch (e) {
        failed.push(`${label}: ${e instanceof Error ? e.message : 'error'}`);
      }
    }
    revalidatePath('/console', 'layout');
    return failed.length
      ? { ok: paid > 0, message: `${paid} approved. ${failed.length} did not go through: ${failed.join('; ')}` }
      : { ok: true, message: `${paid} payment${paid === 1 ? '' : 's'} approved and sent.` };
  } catch (e) {
    return fail(e);
  }
}

export async function retry(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await signer();
    const r = await cosign.retryPayment(str(form, 'payment_id'));
    return done(r.execution ?? `Now ${r.state}.`);
  } catch (e) {
    return fail(e);
  }
}

// --- Invoices -----------------------------------------------------------------------------------

export type UploadState = { ok: boolean; message: string; result?: ReadInvoiceResponse } | null;

export async function submitInvoice(_: UploadState, form: FormData): Promise<UploadState> {
  try {
    await signer();
    const file = form.get('file');
    let input: { text?: string; pdf_base64?: string; filename?: string };
    if (file instanceof File && file.size > 0) {
      if (file.size > 5_000_000) return { ok: false, message: 'That file is over 5 MB. Upload a smaller PDF or paste the text.' };
      const bytes = Buffer.from(await file.arrayBuffer());
      input = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        ? { pdf_base64: bytes.toString('base64'), filename: file.name }
        : { text: bytes.toString('utf8'), filename: file.name };
    } else {
      const text = str(form, 'text');
      if (!text) return { ok: false, message: 'Paste the invoice text or choose a file.' };
      input = { text };
    }
    const result = await cosign.readInvoice(input);
    revalidatePath('/console', 'layout');
    return { ok: true, message: result.status, result };
  } catch (e) {
    if (e instanceof Error && /no mandate/i.test(e.message))
      return { ok: false, message: 'Set your spending limits first. Cosign only pays inside a mandate you have signed: open Mandate and vendors, sign one, then add this invoice again.' };
    return fail(e);
  }
}

// --- Mandate and vendors ------------------------------------------------------------------------

const cents = (v: string) => Math.round(Number(v.replace(/[,$\s]/g, '')) * 100);

export async function saveMandate(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await signer();
    const rules: MandateRules = {
      currency: str(form, 'currency').toUpperCase() || 'USD',
      per_invoice_cap_cents: cents(str(form, 'per_invoice')),
      daily_cap_cents: cents(str(form, 'daily')),
      velocity_max_payments: Number(str(form, 'velocity_max')),
      velocity_window_minutes: Number(str(form, 'velocity_window')),
      due_date_max_past_days: Number(str(form, 'past_days')),
      due_date_max_future_days: Number(str(form, 'future_days')),
    };
    if (Object.values(rules).some((v) => typeof v === 'number' && (!Number.isFinite(v) || v <= 0))) {
      return { ok: false, message: 'Every limit must be a positive number.' };
    }
    const expires = str(form, 'expires');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return { ok: false, message: 'Pick an expiry date.' };
    const m = await cosign.createMandate(rules, `${expires}T23:59:59Z`);
    return done(`Mandate signed. Its hash is ${m.hash.slice(0, 12)}; every decision from now on cites it.`);
  } catch (e) {
    return fail(e);
  }
}

export async function addVendor(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await signer();
    const v = await cosign.createVendor(str(form, 'name'), str(form, 'email'));
    return done(`${v.name} approved. Payouts go only to ${v.paypal_email}.`);
  } catch (e) {
    return fail(e);
  }
}

export type PayMeState = { ok: boolean; message: string; name?: string; email?: string; amount?: string } | null;

/** "Pay yourself": approves the visitor as a vendor at their own PayPal sandbox email (or finds
 *  them already approved), so the next invoice to that email is a routine, payable bill. */
export async function approveMe(_: PayMeState, form: FormData): Promise<PayMeState> {
  try {
    await signer();
    const name = str(form, 'name');
    const email = str(form, 'email').toLowerCase();
    const amount = Number(str(form, 'amount') || '0');
    if (name.length < 2) return { ok: false, message: 'Enter a business name for the invoice.' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: 'Enter the email of a PayPal sandbox personal account.' };
    if (!(amount > 0 && amount <= 1000)) return { ok: false, message: 'Pick an amount between 0.01 and 1,000.00.' };
    const vendors = await cosign.getVendors();
    const same = vendors.find((v) => v.paypal_email.toLowerCase() === email);
    const vendor = same ?? (await cosign.createVendor(name, email));
    revalidatePath('/console', 'layout');
    return {
      ok: true,
      message: same ? `${vendor.name} is already approved at ${email}.` : `${vendor.name} approved. Payouts may go to ${email}.`,
      name: vendor.name,
      email,
      amount: amount.toFixed(2),
    };
  } catch (e) {
    return fail(e);
  }
}

// --- Milestones ---------------------------------------------------------------------------------

export async function createDeal(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await signer();
    const titles = form.getAll('m_title').map(String);
    const amounts = form.getAll('m_amount').map(String);
    const criteria = form.getAll('m_criteria').map(String);
    const milestones = titles
      .map((t, i) => ({
        title: t.trim(),
        amount: amounts[i]?.replace(/[,$\s]/g, '') ?? '',
        currency: 'USD',
        criteria: (criteria[i] ?? '').split('\n').map((c) => c.trim()).filter(Boolean),
      }))
      .filter((m) => m.title || m.amount);
    const d = await cosign.createDeal({ title: str(form, 'title'), seller: str(form, 'seller'), seller_email: str(form, 'seller_email'), milestones });
    return done(`Deal "${d.title}" created with ${d.milestones.length} milestones.`);
  } catch (e) {
    return fail(e);
  }
}

export async function milestoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const who = await signer();
    const id = str(form, 'milestone_id');
    const note = str(form, 'note') || undefined;
    switch (str(form, 'op')) {
      case 'fund': {
        const r = await cosign.fundMilestone(id);
        return done(r.approve_url ? `Approve the hold at PayPal, then confirm: ${r.approve_url}` : 'Funded. The money is held, not paid.');
      }
      case 'confirm':
        await cosign.confirmFunding(id);
        return done('Hold placed. The money is reserved for this milestone.');
      case 'deliver': {
        const evidence = str(form, 'evidence');
        if (!evidence) return { ok: false, message: 'Describe what was delivered, with links.' };
        const links = str(form, 'links').split(/\s+/).filter(Boolean);
        const m = await cosign.deliverMilestone(id, evidence, links);
        // The agent checks the evidence against the criteria and reports to the core.
        try {
          const c = await cosign.checkMilestone({ milestone_id: id, evidence_hash: m.evidence_hash!, criteria: m.criteria, evidence });
          return done(c.core?.decision === 'ALLOW' ? 'Delivered and verified against every criterion. Release when you are ready.' : 'Delivered, but the check did not pass. It is held for your decision.', true);
        } catch (e) {
          return done(`Delivered. The automatic check did not run (${e instanceof Error ? e.message : 'agent error'}); review it yourself.`, true);
        }
      }
      case 'accept':
        await cosign.acceptMilestone(id, who, note);
        return done('Accepted. You can release the funds now.');
      case 'reject':
        await cosign.rejectMilestone(id, who, note);
        return done('Rejected. The funds stay held until the seller delivers again.');
      case 'release': {
        const r = await cosign.releaseMilestone(id);
        return done(r.milestone.state === 'RELEASED' ? 'Released. The seller has been paid.' : r.execution);
      }
      case 'void':
        await cosign.voidMilestone(id, who, note);
        return done('Voided. The hold on the funds is cancelled.');
      default:
        return { ok: false, message: 'Unknown action.' };
    }
  } catch (e) {
    return fail(e);
  }
}

export type { DecisionResponse };
