'use client';

import { useActionState, useState } from 'react';
import { PencilLine, Power, ShieldAlert } from 'lucide-react';
import type { Vendor } from '@/lib/cosign-types';
import { editVendor } from '../../actions';
import { Submit, useActionToast } from '../../client';
import { Card, ErrorNote, Field, inputClass } from '../../ui';

/** Edit a vendor. Changing where money goes is the most abused step in accounts payable, so a
 *  new payout email needs a note on how it was verified, and every change lands in the audit log
 *  with the signed-in person's name. */
export function VendorEditor({ vendor }: { vendor: Vendor }) {
  const [state, action] = useActionState(editVendor, null);
  const [toggle, toggleAction] = useActionState(editVendor, null);
  useActionToast(state, 'Vendor saved');
  useActionToast(toggle, vendor.active ? 'Vendor deactivated' : 'Vendor approved again');
  const [email, setEmail] = useState(vendor.paypal_email);
  const emailChanged = email.trim().toLowerCase() !== vendor.paypal_email.toLowerCase();

  return (
    <div className="space-y-6">
      <form action={action}>
        <input type="hidden" name="id" value={vendor.id} />
        <input type="hidden" name="intent" value="edit" />
        <Card className="p-5">
          <p className="flex items-center gap-2 font-bold">
            <PencilLine aria-hidden className="size-5 text-cs-sign" /> Edit vendor
          </p>
          <div className="mt-4 space-y-4">
            <Field label="Vendor name">
              <input name="name" defaultValue={vendor.name} required maxLength={120} className={inputClass} />
            </Field>
            <Field label="PayPal payout email" hint="Cosign pays this vendor here and nowhere else.">
              <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={inputClass} />
            </Field>
            {emailChanged && (
              <div className="rounded-lg border border-cs-held/40 bg-cs-held-wash p-3">
                <p className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
                  <ShieldAlert aria-hidden className="size-4 text-cs-held" /> Changing where money goes
                </p>
                <p className="mt-1 text-xs text-cs-soft">
                  Invoices asking to be paid somewhere new are the most common accounts-payable fraud. Confirm the new email with the vendor through a channel you already trust,
                  never one given in the invoice or email that asked for the change.
                </p>
                <Field label="How did you verify it?">
                  <input name="reason" required minLength={8} placeholder="Called Ana on the number in our contract" className={inputClass} />
                </Field>
              </div>
            )}
            {state && !state.ok && <ErrorNote>{state.message}</ErrorNote>}
            <Submit pending="Saving…">Save changes</Submit>
          </div>
        </Card>
      </form>

      <form action={toggleAction}>
        <input type="hidden" name="id" value={vendor.id} />
        <input type="hidden" name="intent" value={vendor.active ? 'deactivate' : 'reactivate'} />
        <Card className="p-5">
          <p className="flex items-center gap-2 font-bold">
            <Power aria-hidden className={`size-5 ${vendor.active ? 'text-cs-blocked' : 'text-cs-cleared'}`} /> {vendor.active ? 'Deactivate' : 'Approve again'}
          </p>
          <p className="mt-1 text-sm text-cs-soft">
            {vendor.active
              ? 'Takes the vendor off the approved list. Nothing is deleted: its history stays, and any new invoice from it waits for your signature.'
              : 'Puts the vendor back on the approved list, so routine invoices to the email above are paid automatically again.'}
          </p>
          <div className="mt-3 space-y-3">
            <Field label="Reason (for the audit log)">
              <input name="reason" placeholder={vendor.active ? 'Contract ended' : 'New contract signed'} className={inputClass} />
            </Field>
            {toggle && !toggle.ok && <ErrorNote>{toggle.message}</ErrorNote>}
            <Submit pending="Saving…" variant={vendor.active ? 'danger' : 'success'}>
              {vendor.active ? 'Deactivate vendor' : 'Approve again'}
            </Submit>
          </div>
        </Card>
      </form>
    </div>
  );
}
