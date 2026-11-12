'use client';

import { useActionState, useState } from 'react';
import { Check } from 'lucide-react';
import { day, money, MILESTONE_STATE } from '@/lib/cosign-format';
import type { Milestone } from '@/lib/cosign-types';
import { createDeal, milestoneAction } from '../actions';
import { Submit, useActionToast } from '../client';
import { Chip, ErrorNote, Field, Hash, inputClass, Reasons, Stamp } from '../ui';

export function MilestoneCard({ m }: { m: Milestone }) {
  const [state, action] = useActionState(milestoneAction, null);
  useActionToast(state, m.title);
  const st = MILESTONE_STATE[m.state];
  const results = m.criteria_result?.results ?? [];
  const held = m.state === 'DELIVERED' && m.hold_reasons.length > 0 && !m.buyer_accepted_hold;
  const op = (name: string, label: string, pending: string, variant: 'primary' | 'quiet' | 'danger' = 'primary') => (
    <Submit name="op" value={name} pending={pending} variant={variant}>
      {label}
    </Submit>
  );

  return (
    <li id={m.id} className={`relative flex scroll-mt-24 flex-col rounded-xl border bg-cs-paper p-5 ${held ? 'border-cs-held ring-2 ring-cs-held/20' : 'border-cs-edge'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-cs-faint">Stage {m.seq}</p>
          <p className="text-lg font-bold">{m.title}</p>
          <p className="text-xl font-bold">{money(m.amount_cents, m.currency)}</p>
        </div>
        {m.state === 'RELEASED' ? (
          <Stamp tone="cleared" size="sm">
            Released
          </Stamp>
        ) : held ? (
          <Stamp tone="held" size="sm">
            Held
          </Stamp>
        ) : (
          <Chip tone={st.tone}>{st.label}</Chip>
        )}
      </div>

      <Stepper state={m.state} held={held} />

      <p className="mt-4 text-sm font-semibold text-cs-soft">Acceptance criteria</p>
      <ul className="mt-1 space-y-1 text-sm">
        {m.criteria.map((c) => {
          const r = results.find((x) => x.criterion === c);
          return (
            <li key={c} className="flex gap-2">
              <span aria-hidden className={r ? (r.passed ? 'text-cs-cleared' : 'text-cs-blocked') : 'text-cs-faint'}>
                {r ? (r.passed ? '✓' : '✗') : '○'}
              </span>
              <span>
                {c}
                {r && <span className="block text-xs text-cs-soft">{r.reason}</span>}
                <span className="sr-only">{r ? (r.passed ? ' (met)' : ' (not met)') : ' (not checked yet)'}</span>
              </span>
            </li>
          );
        })}
      </ul>

      {m.evidence && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold text-cs-soft">What the seller delivered</summary>
          <p className="mt-1 whitespace-pre-wrap text-cs-ink">{m.evidence.text}</p>
          {m.evidence.links.map((l) => (
            <p key={l} className="break-all text-cs-sign">{l}</p>
          ))}
        </details>
      )}
      {held && (
        <div className="mt-3 rounded-[3px] bg-cs-held-wash px-3 py-2">
          <Reasons reasons={m.hold_reasons} />
        </div>
      )}
      {m.blocked_by && !held && <p className="mt-3 text-sm text-cs-held">Waiting: {m.blocked_by}.</p>}

      <form action={action} className="mt-auto space-y-3 pt-4">
        <input type="hidden" name="milestone_id" value={m.id} />
        {m.state === 'DRAFT' && !m.approve_url && <div>{op('fund', 'Fund this stage', 'Placing the hold…')}</div>}
        {m.state === 'DRAFT' && m.approve_url && (
          <div className="space-y-2 text-sm">
            <a href={m.approve_url} target="_blank" rel="noreferrer" className="font-semibold text-cs-sign hover:underline">
              Approve the hold at PayPal
            </a>
            <div>{op('confirm', 'I approved it, place the hold', 'Confirming…')}</div>
          </div>
        )}
        {m.state === 'FUNDED' && !m.blocked_by && (
          <>
            <Field label="Delivery evidence" hint="Describe what was delivered. The agent checks it against each criterion.">
              <textarea name="evidence" rows={3} className={inputClass} />
            </Field>
            <Field label="Links" hint="Optional, separated by spaces">
              <input name="links" className={inputClass} placeholder="https://figma.example/file" />
            </Field>
          </>
        )}
        {(held || m.state === 'DELIVERED') && (
          <Field label="Note">
            <input name="note" className={inputClass} placeholder="Why you accept or reject it" />
          </Field>
        )}
        <div className="flex flex-wrap gap-2">
          {m.state === 'FUNDED' && !m.blocked_by && op('deliver', 'Submit delivery', 'Checking the work…')}
          {m.state === 'DELIVERED' && op('accept', held ? 'Accept anyway' : 'Accept the work', 'Accepting…', held ? 'quiet' : 'primary')}
          {m.state === 'DELIVERED' && op('reject', 'Reject, ask for redelivery', 'Rejecting…', 'quiet')}
          {m.state === 'VERIFIED' && op('release', `Release ${money(m.amount_cents, m.currency)} to the seller`, 'Releasing…')}
          {['FUNDED', 'DELIVERED', 'VERIFIED'].includes(m.state) && op('void', 'Cancel and void the hold', 'Voiding…', 'danger')}
        </div>
        {state && !state.ok && <ErrorNote>{state.message}</ErrorNote>}
      </form>

      {(m.authorization_id || m.payout_ref) && (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-cs-rule pt-3 text-xs text-cs-soft">
          {m.authorization_id && m.state !== 'RELEASED' && (
            <>
              <dt>Hold</dt>
              <dd>
                <Hash value={m.authorization_id} n={18} />
                {m.auth_expires_at && `, until ${day(m.auth_expires_at)}`}
                {m.reauthorized_count > 0 && ', renewed once'}
              </dd>
            </>
          )}
          {m.payout_ref && (
            <>
              <dt>Payout</dt>
              <dd><Hash value={m.payout_ref} n={18} /></dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}

type Row = { title: string; amount: string; criteria: string };
const SAMPLE: Row[] = [
  { title: 'Wireframes', amount: '500.00', criteria: 'Wireframes for home, pricing and contact pages\nMobile layouts included' },
  { title: 'Visual design', amount: '1200.00', criteria: 'High-fidelity mockups in Figma\nDesign system with colours and type' },
];

export function DealForm() {
  const [state, action] = useActionState(createDeal, null);
  useActionToast(state, 'Deal created');
  const [rows, setRows] = useState<Row[]>(SAMPLE);
  return (
    <form action={action} className="cs-card space-y-5 p-6" key={state?.ok ? state.message : 'form'}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Project">
          <input name="title" required defaultValue="Website rebuild" className={inputClass} />
        </Field>
        <Field label="Seller">
          <input name="seller" required defaultValue="Northwind Design Studio" className={inputClass} />
        </Field>
        <Field label="Seller PayPal email" hint="Released funds go here">
          <input name="seller_email" type="email" required defaultValue="billing@northwind.example" className={inputClass} />
        </Field>
      </div>
      <ol className="space-y-4">
        {rows.map((r, i) => (
          <li key={i} className="grid gap-3 border-t border-cs-rule pt-4 sm:grid-cols-[1fr_8rem_2fr]">
            <Field label={`Stage ${i + 1}`}>
              <input name="m_title" required defaultValue={r.title} className={inputClass} />
            </Field>
            <Field label="Amount, USD">
              <input name="m_amount" required inputMode="decimal" defaultValue={r.amount} className={inputClass} />
            </Field>
            <Field label="Acceptance criteria" hint="One per line">
              <textarea name="m_criteria" required rows={2} defaultValue={r.criteria} className={inputClass} />
            </Field>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setRows([...rows, { title: '', amount: '', criteria: '' }])} className="h-9 rounded-[3px] border border-cs-edge px-4 text-sm font-semibold hover:border-cs-ink">
          Add a stage
        </button>
        {rows.length > 1 && (
          <button type="button" onClick={() => setRows(rows.slice(0, -1))} className="h-9 rounded-[3px] px-3 text-sm text-cs-soft hover:text-cs-ink">
            Remove the last stage
          </button>
        )}
        <Submit pending="Creating…">Create the deal</Submit>
      </div>
      {state && !state.ok && <ErrorNote>{state.message}</ErrorNote>}
    </form>
  );
}

const STEPS = [
  { key: 'FUNDED', label: 'Funded' },
  { key: 'DELIVERED', label: 'Delivered' },
  { key: 'VERIFIED', label: 'Verified' },
  { key: 'RELEASED', label: 'Released' },
] as const;
const ORDER: Record<string, number> = { DRAFT: -1, FUNDED: 0, DELIVERED: 1, VERIFIED: 2, RELEASED: 3, VOIDED: -2, EXPIRED: -2 };

/** Where the stage is: funded, delivered, verified, released. */
function Stepper({ state, held }: { state: Milestone['state']; held: boolean }) {
  if (state === 'VOIDED' || state === 'EXPIRED') return <p className="mt-4 text-sm font-semibold text-cs-soft">{state === 'VOIDED' ? 'Cancelled. The hold was voided.' : 'The PayPal hold expired before release.'}</p>;
  const at = ORDER[state];
  return (
    <ol className="mt-4 grid grid-cols-4 gap-1" aria-label="Progress">
      {STEPS.map((s, i) => {
        const done = i <= at;
        const isHeld = held && s.key === 'DELIVERED';
        return (
          <li key={s.key} className="min-w-0">
            <div className={`h-1.5 rounded-full ${isHeld ? 'bg-cs-held' : done ? 'bg-cs-cleared' : 'bg-cs-rule'}`} />
            <p className={`mt-1.5 flex items-center gap-1 truncate text-[11px] ${done ? 'font-semibold text-cs-ink' : 'text-cs-faint'}`}>
              {done && !isHeld && <Check aria-hidden className="size-3 text-cs-cleared" />}
              {isHeld ? 'Held' : s.label}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
