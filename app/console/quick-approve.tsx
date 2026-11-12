'use client';

import Link from 'next/link';
import { decidePayment } from './actions';
import { Submit, withToast } from './client';

/** Approve straight from a list. Denying needs a reason, so it opens the full card instead. */
export function QuickApprove({ paymentId, decisionHash, label }: { paymentId: string; decisionHash: string; label: string }) {
  return (
    <form action={withToast(decidePayment, 'Approved and sent')} className="flex items-center gap-2">
      <input type="hidden" name="payment_id" value={paymentId} />
      <input type="hidden" name="decision_hash" value={decisionHash} />
      <input type="hidden" name="label" value={label} />
      <input type="hidden" name="note" value="Approved from the overview" />
      <Link href={`/console/inbox?id=${paymentId}`} className="inline-flex h-8 items-center rounded-lg border border-cs-edge px-3 text-xs font-semibold hover:bg-cs-hover">
        Review
      </Link>
      <Submit name="verdict" value="approve" pending="Signing…" size="sm" variant="success">
        Approve
      </Submit>
    </form>
  );
}
