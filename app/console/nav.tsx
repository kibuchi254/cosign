'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/console', label: 'Overview' },
  { href: '/console/inbox', label: 'Needs your signature' },
  { href: '/console/invoices/new', label: 'Add an invoice' },
  { href: '/console/payments', label: 'Payments' },
  { href: '/console/milestones', label: 'Milestones' },
  { href: '/console/mandate', label: 'Mandate and vendors' },
  { href: '/console/audit', label: 'Audit log' },
  { href: '/console/report', label: 'Reports' },
];

export function Nav({ waiting }: { waiting: number }) {
  const path = usePathname();
  return (
    <nav aria-label="Console" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
      {ITEMS.map((item) => {
        const active = item.href === '/console' ? path === '/console' : path.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center justify-between gap-3 rounded-[3px] px-3 py-2 text-sm whitespace-nowrap ${
              active ? 'bg-cs-sign-wash font-semibold text-cs-sign-deep' : 'text-cs-soft hover:bg-cs-canvas hover:text-cs-ink'
            }`}
          >
            {item.label}
            {item.href === '/console/inbox' && waiting > 0 && (
              <span className="rounded-full bg-cs-held px-1.5 text-xs font-bold text-white" aria-label={`${waiting} waiting`}>
                {waiting}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
