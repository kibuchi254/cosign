import type { Metadata } from 'next';
import { connection } from 'next/server';
import { getVendors } from '@/lib/cosign';
import { money } from '@/lib/cosign-format';
import { VendorDirectory } from '../mandate/forms';
import { CoreDown, PageHead } from '../ui';

export const metadata: Metadata = { title: 'Vendors' };

export default async function VendorsPage() {
  await connection();
  let vendors;
  try {
    vendors = await getVendors();
  } catch (e) {
    return <CoreDown error={e} />;
  }
  const active = vendors.filter((v) => v.active);
  const paid = vendors.reduce((s, v) => s + v.paid_cents, 0);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHead
        title="Vendors"
        lede="Who Cosign may pay, and the only PayPal email each may be paid at. An invoice asking to be paid anywhere else is blocked; one from a vendor not on this list waits for you."
      />
      <div className="mb-6 grid grid-cols-3 gap-3 sm:max-w-xl">
        {[
          ['Approved', String(active.length)],
          ['Inactive', String(vendors.length - active.length)],
          ['Paid to vendors', money(paid, 'USD')],
        ].map(([k, v]) => (
          <div key={k} className="cs-card px-4 py-3">
            <p className="text-xs text-cs-soft">{k}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      <VendorDirectory vendors={vendors} />
    </div>
  );
}
