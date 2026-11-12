import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { getMandate, getVendors } from '@/lib/cosign';
import { CosignError } from '@/lib/cosign-error';
import { day, when } from '@/lib/cosign-format';
import type { Mandate } from '@/lib/cosign-types';
import { CoreDown, Hash, PageHead } from '../ui';
import { MandateForm, VendorDirectory } from './forms';

export const metadata: Metadata = { title: 'Mandate and vendors' };

// A new mandate defaults to 90 days, long enough to cover judging.
function inNinetyDays(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 90);
  return d.toISOString();
}

export default async function MandatePage({ searchParams }: PageProps<'/console/mandate'>) {
  await connection();
  const tab = (await searchParams).tab === 'vendors' ? 'vendors' : 'limits';
  let mandate: Mandate | null = null;
  let vendors;
  try {
    vendors = await getVendors();
    mandate = await getMandate().catch((e) => {
      if (e instanceof CosignError && e.status === 404) return null;
      throw e;
    });
  } catch (e) {
    return <CoreDown error={e} />;
  }
  return (
    <div className="mx-auto max-w-6xl">
      <PageHead
        title="Mandate and vendors"
        lede="What Cosign may do without asking you, and who it may pay. Anything outside these lines waits for your signature."
      />
      <div role="tablist" aria-label="Section" className="mb-6 flex gap-1 border-b border-cs-edge">
        {[
          { key: 'limits', label: 'Spending limits', href: '/console/mandate' },
          { key: 'vendors', label: `Approved vendors (${vendors.length})`, href: '/console/mandate?tab=vendors' },
        ].map((t) => (
          <Link
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            href={t.href}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm ${tab === t.key ? 'border-cs-sign font-semibold text-cs-sign-deep' : 'border-transparent text-cs-soft hover:text-cs-ink'}`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      {tab === 'limits' ? (
        <>
          {mandate ? (
            <p className="mb-4 text-sm text-cs-soft">
              Current mandate <Hash value={mandate.hash} n={16} />, signed {when(mandate.created_at)}, valid until {day(mandate.expires_at)}. Signing a new one keeps this one in the audit log, and every decision cites the hash of the mandate it used.
            </p>
          ) : (
            <p className="mb-4 text-sm font-semibold text-cs-held">You have no mandate yet, so Cosign will not pay anything. Sign one below.</p>
          )}
          <MandateForm mandate={mandate} defaultExpiry={(mandate?.expires_at ?? inNinetyDays()).slice(0, 10)} />
        </>
      ) : (
        <VendorDirectory vendors={vendors} />
      )}
    </div>
  );
}
