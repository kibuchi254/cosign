import type { Metadata } from 'next';
import { ShieldAlert } from 'lucide-react';
import { getLedger } from '@/lib/cosign';
import { ButtonLink, PageHead } from '../../ui';
import { UploadForm } from './upload-form';

export const metadata: Metadata = { title: 'Add an invoice' };

export default async function NewInvoice() {
  const ledger = await getLedger().catch(() => undefined);
  const mandate = ledger ? ledger.mandate : undefined;
  return (
    <div className="mx-auto max-w-7xl">
      <PageHead
        title="Add an invoice"
        lede="Upload or paste an invoice. Cosign pays it, holds it for your signature, or blocks it, and shows you exactly why."
      />
      {mandate === null && (
        <div role="status" className="cs-card mb-6 flex flex-wrap items-center gap-4 border-cs-held/40 bg-cs-held-wash px-5 py-4">
          <ShieldAlert aria-hidden className="size-6 shrink-0 text-cs-held" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-cs-ink">Sign a mandate before Cosign can pay anything</p>
            <p className="text-sm text-cs-soft">Your limits tell Cosign what it may pay on its own. It takes about a minute.</p>
          </div>
          <ButtonLink href="/console/mandate">Set your limits</ButtonLink>
        </div>
      )}
      <UploadForm live={ledger ? !ledger.simulation : false} />
    </div>
  );
}
