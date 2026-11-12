import type { Metadata } from 'next';
import { connection } from 'next/server';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { getAudit, verifyAudit } from '@/lib/cosign';
import { AUDIT_KIND, auditDetail, auditTone } from '@/lib/cosign-format';
import { Card, CoreDown, Hash, PageHead } from '../ui';
import { AuditView, type Row } from './audit-view';

export const metadata: Metadata = { title: 'Audit log' };

export default async function Audit() {
  await connection();
  let entries, report;
  try {
    [entries, report] = await Promise.all([getAudit(1000), verifyAudit()]);
  } catch (e) {
    return <CoreDown error={e} />;
  }
  const rows: Row[] = [...entries].reverse().map((e) => ({ ...e, title: AUDIT_KIND[e.kind] ?? e.kind, detail: auditDetail(e), tone: auditTone(e) }));
  return (
    <div className="mx-auto max-w-7xl">
      <PageHead
        title="Audit log"
        lede="Every decision, signature and PayPal event, in order. Each entry is sealed with the one before it, so changing any past entry breaks every seal after it."
      />
      <Card className={`mb-6 flex flex-wrap items-center gap-4 p-5 ${report.ok ? '' : 'border-cs-blocked bg-cs-blocked-wash'}`}>
        <span className={`flex size-11 items-center justify-center rounded-full ${report.ok ? 'bg-cs-cleared-wash text-cs-cleared' : 'bg-cs-blocked text-cs-on-accent'}`}>
          {report.ok ? <ShieldCheck aria-hidden className="size-6" /> : <ShieldAlert aria-hidden className="size-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">{report.ok ? 'Chain intact' : `Chain broken at entry ${report.first_broken_seq}`}</p>
          <p className="text-sm text-cs-soft">{report.ok ? `All ${report.entries} seals were just recomputed and match.` : report.problem}</p>
        </div>
        <div className="text-sm text-cs-soft">
          Latest seal <Hash value={report.head_hash} n={20} />
          <p className="text-xs text-cs-faint">Anyone can check it at /v1/audit/verify on the core.</p>
        </div>
      </Card>
      <AuditView rows={rows} />
    </div>
  );
}
