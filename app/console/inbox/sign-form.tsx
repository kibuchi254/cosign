'use client';

import { useState } from 'react';
import { decidePayment } from '../actions';
import { Submit, withToast } from '../client';
import { inputClass } from '../ui';

export function SignForm({
  paymentId,
  decisionHash,
  amount,
  label,
  newVendor,
}: {
  paymentId: string;
  decisionHash: string;
  amount: string;
  label: string;
  /** Set when the only objection is a new vendor: offer to approve it while signing. */
  newVendor?: { name: string; email: string };
}) {
  const [denying, setDenying] = useState(false);
  return (
    <form action={withToast(decidePayment, denying ? 'Denied' : 'Approved and sent')} className="flex flex-col gap-3">
      <input type="hidden" name="payment_id" value={paymentId} />
      <input type="hidden" name="decision_hash" value={decisionHash} />
      <input type="hidden" name="label" value={label} />
      <p className="text-sm font-bold">Your decision</p>
      <label className="block text-sm">
        <span className="text-cs-soft">{denying ? 'Why are you denying it? (required)' : 'Note for the audit log (optional)'}</span>
        <textarea
          name="note"
          rows={4}
          required={denying}
          placeholder={denying ? 'For example: vendor confirmed by phone they did not send this' : 'For example: confirmed the new vendor by phone'}
          className={`${inputClass} mt-1`}
        />
      </label>
      {newVendor && !denying && (
        <label className="flex items-start gap-2.5 rounded-lg border border-cs-edge bg-cs-paper p-3 text-sm">
          <input type="checkbox" name="add_vendor" value="1" className="mt-0.5 size-4 accent-[var(--cs-sign)]" />
          <span>
            <span className="block font-semibold">Also approve {newVendor.name} as a vendor</span>
            <span className="block text-xs text-cs-soft">At {newVendor.email} only. Their next routine invoice is paid automatically. Only tick this if you have checked who they are.</span>
          </span>
        </label>
      )}
      <div className="cs-signline pt-6" aria-hidden />
      <p className="-mt-1 text-xs text-cs-faint">Signing records your name with this decision.</p>
      {denying ? (
        <div className="flex flex-wrap gap-2">
          <Submit name="verdict" value="deny" pending="Recording…" variant="danger">
            Deny payment
          </Submit>
          <button type="button" onClick={() => setDenying(false)} className="h-10 rounded-lg px-3 text-sm text-cs-soft hover:text-cs-ink">
            Back
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Submit name="verdict" value="approve" pending="Signing…" variant="success">
            Approve and pay {amount}
          </Submit>
          <button type="button" onClick={() => setDenying(true)} className="h-10 rounded-lg border border-cs-edge text-sm font-semibold text-cs-blocked hover:bg-cs-blocked-wash">
            Deny
          </button>
        </div>
      )}
    </form>
  );
}
