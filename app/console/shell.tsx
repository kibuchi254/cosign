'use client';

// The console frame: sidebar on desktop, a top bar with search (⌘K), "New", notifications,
// theme and account, and a bottom tab bar on phones. Exceptions are counted wherever you are.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Bell,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  FileUp,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Milestone,
  Moon,
  Plus,
  ReceiptText,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { money } from '@/lib/cosign-format';
import { Toaster } from './toast';

export type SearchItem = { label: string; hint?: string; href: string; group: 'Pages' | 'Actions' | 'Payments' | 'Vendors' | 'Deals' };
export type MandateSummary = {
  currency: string;
  perInvoiceCents: number;
  dailyCapCents: number;
  usedTodayCents: number;
  velocity: string;
  expiresAt: string;
  expiresLabel: string;
  hash: string;
};
export type Notice = { title: string; body: string; href: string; tone: 'held' | 'blocked' | 'sign' };

type NavItem = { href: string; label: string; icon: LucideIcon; count?: number };

export function Shell({
  children,
  user,
  waiting,
  simulation,
  mandate,
  search,
  notices,
  logout,
}: {
  children: ReactNode;
  user: string;
  waiting: number;
  simulation: boolean | null;
  mandate: MandateSummary | null;
  search: SearchItem[];
  notices: Notice[];
  logout: () => Promise<void>;
}) {
  const path = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Payments',
      items: [
        { href: '/console', label: 'Overview', icon: LayoutDashboard },
        { href: '/console/inbox', label: 'Approvals', icon: Inbox, count: waiting },
        { href: '/console/invoices/new', label: 'Add an invoice', icon: FileUp },
        { href: '/console/payments', label: 'All payments', icon: ReceiptText },
      ],
    },
    { title: 'Escrow', items: [{ href: '/console/milestones', label: 'Milestones', icon: Milestone }] },
    {
      title: 'Controls',
      items: [
        { href: '/console/mandate', label: 'Mandate and vendors', icon: ShieldCheck },
        { href: '/console/audit', label: 'Audit log', icon: ScrollText },
        { href: '/console/report', label: 'Reports', icon: ChartColumn },
      ],
    },
  ];
  const isActive = (href: string) => (href === '/console' ? path === '/console' : path.startsWith(href));

  const nav = (
    <nav aria-label="Console" className="flex flex-col gap-5 px-3">
      {groups.map((g) => (
        <div key={g.title}>
          <p className="px-3 pb-1.5 text-xs font-semibold text-cs-faint">{g.title}</p>
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                      active ? 'bg-cs-sign-wash font-semibold text-cs-sign-deep' : 'text-cs-soft hover:bg-cs-hover hover:text-cs-ink'
                    }`}
                  >
                    <Icon aria-hidden className={`size-[18px] ${active ? 'text-cs-sign' : 'text-cs-faint group-hover:text-cs-soft'}`} />
                    <span className="flex-1">{item.label}</span>
                    {!!item.count && (
                      <span className="rounded-full bg-cs-held px-2 py-px text-xs font-bold text-cs-on-accent tabular-nums" aria-label={`${item.count} waiting`}>
                        {item.count}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const sidebarFoot = (
    <div className="space-y-2.5 border-t border-cs-rule px-3 py-3">
      <MandateCard mandate={mandate} onNavigate={() => setDrawerOpen(false)} />
      {simulation !== null && <RailStatus simulation={simulation} />}
    </div>
  );

  return (
    <div className="cosign flex min-h-dvh">
      {/* Desktop sidebar */}
      <div className="hidden w-64 shrink-0 border-r border-cs-edge bg-cs-paper lg:block">
      <aside className="sticky top-0 flex h-dvh flex-col">
        <Link href="/console" className="flex items-center gap-2.5 px-6 pt-6 pb-6">
          <Logo />
          <span className="text-lg font-extrabold tracking-tight">Cosign</span>
        </Link>
        <div className="cs-scroll min-h-0 flex-1 overflow-y-auto pb-4">{nav}</div>
        {sidebarFoot}
      </aside>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/30" onClick={() => setDrawerOpen(false)} />
          <aside className="cs-slide-in absolute inset-y-0 left-0 flex w-72 flex-col bg-cs-paper">
            <div className="flex items-center justify-between px-6 pt-5 pb-5">
              <span className="flex items-center gap-2.5 text-lg font-extrabold">
                <Logo /> Cosign
              </span>
              <button type="button" aria-label="Close menu" onClick={() => setDrawerOpen(false)} className="text-cs-soft">
                <X className="size-5" />
              </button>
            </div>
            <div className="cs-scroll min-h-0 flex-1 overflow-y-auto pb-4">{nav}</div>
            {sidebarFoot}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-cs-edge bg-cs-paper/90 px-4 backdrop-blur sm:px-6 lg:px-8">
          <button type="button" aria-label="Open menu" onClick={() => setDrawerOpen(true)} className="-ml-1 rounded-lg p-1.5 text-cs-soft hover:bg-cs-hover lg:hidden">
            <Menu className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-cs-edge bg-cs-panel px-3 text-left text-sm text-cs-faint hover:border-cs-faint sm:max-w-md"
          >
            <Search aria-hidden className="size-4 shrink-0" />
            <span className="truncate">Search payments, vendors, pages</span>
            <kbd className="ml-auto hidden rounded border border-cs-edge px-1.5 font-sans text-[11px] text-cs-faint sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <NewMenu />
            <Notifications notices={notices} />
            <ThemeToggle />
            <UserMenu user={user} logout={logout} />
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 pt-6 pb-24 sm:px-6 lg:px-8 lg:pb-10">{children}</main>
      </div>

      {/* Phone tab bar */}
      <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-cs-edge bg-cs-paper pb-[env(safe-area-inset-bottom)] lg:hidden">
        {[
          { href: '/console', label: 'Overview', icon: LayoutDashboard },
          { href: '/console/inbox', label: 'Sign', icon: Inbox, count: waiting },
          { href: '/console/invoices/new', label: 'Add', icon: FileUp },
          { href: '/console/payments', label: 'Payments', icon: ReceiptText },
        ].map((t) => {
          const Icon = t.icon;
          const active = isActive(t.href);
          return (
            <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] ${active ? 'font-semibold text-cs-sign' : 'text-cs-soft'}`}>
              <Icon aria-hidden className="size-5" />
              {t.label}
              {!!t.count && <span className="absolute top-1 left-1/2 ml-2 rounded-full bg-cs-held px-1.5 text-[10px] font-bold text-cs-on-accent">{t.count}</span>}
            </Link>
          );
        })}
      </nav>

      {paletteOpen && <Palette items={search} onClose={() => setPaletteOpen(false)} />}
      <Toaster />
    </div>
  );
}

// --- Mandate card -------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The signed spending mandate, shown like an account limit: today's usage against the daily
 *  cap, the per-invoice ceiling and the velocity rule, with the hash every decision quotes. */
function MandateCard({ mandate, onNavigate }: { mandate: MandateSummary | null; onNavigate: () => void }) {
  // One "now" per mount; days-left only needs day precision.
  const [now] = useState(() => Date.now());
  if (!mandate) {
    return (
      <Link href="/console/mandate" onClick={onNavigate} className="flex items-center gap-3 rounded-xl border border-dashed border-cs-blocked bg-cs-paper px-3 py-3 text-xs hover:bg-cs-hover">
        <ShieldAlert aria-hidden className="size-5 shrink-0 text-cs-blocked" />
        <span>
          <span className="block font-semibold text-cs-ink">No active mandate</span>
          <span className="text-cs-soft">Cosign pays nothing until you sign one.</span>
        </span>
      </Link>
    );
  }
  const m = mandate;
  const pct = m.dailyCapCents > 0 ? Math.min(100, (m.usedTodayCents / m.dailyCapCents) * 100) : 0;
  const daysLeft = Math.max(0, Math.ceil((new Date(m.expiresAt).getTime() - now) / DAY_MS));
  const expiring = daysLeft <= 14;
  const bar = pct >= 90 ? 'bg-cs-blocked' : pct >= 70 ? 'bg-cs-held' : 'bg-cs-cleared';
  const remaining = Math.max(0, m.dailyCapCents - m.usedTodayCents);

  return (
    <Link
      href="/console/mandate"
      onClick={onNavigate}
      aria-label={`Spending mandate: ${money(m.usedTodayCents, m.currency)} of ${money(m.dailyCapCents, m.currency)} used today. Manage limits.`}
      className="group block overflow-hidden rounded-xl border border-cs-edge bg-cs-paper transition-shadow hover:shadow-[var(--cs-shadow-lift)]"
      style={{ boxShadow: 'var(--cs-shadow)' }}
    >
      <div className="flex items-center justify-between gap-2 bg-cs-sign px-3 py-2 text-cs-on-accent">
        <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.06em] whitespace-nowrap uppercase">
          <ShieldCheck aria-hidden className="size-3.5 shrink-0" /> Mandate
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap">
          <span className={`size-1.5 rounded-full ${expiring ? 'bg-amber-300' : 'bg-emerald-300'}`} aria-hidden />
          {expiring ? 'Renew soon' : 'Active'}
        </span>
      </div>

      <div className="px-3 pt-3">
        <p className="text-[10px] font-semibold tracking-[0.08em] text-cs-faint uppercase">Used today</p>
        <p className="mt-0.5 flex items-baseline gap-1.5">
          <span className="text-lg font-bold tracking-tight text-cs-ink tabular-nums">{money(m.usedTodayCents, m.currency)}</span>
          <span className="text-[11px] text-cs-faint tabular-nums">of {money(m.dailyCapCents, m.currency)}</span>
        </p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-cs-rule" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Daily cap used">
          <div className={`h-full rounded-full ${bar} transition-[width] duration-500`} style={{ width: `${pct > 0 ? Math.max(pct, 3) : 0}%` }} />
        </div>
        <p className="mt-1 text-[11px] text-cs-soft tabular-nums">{money(remaining, m.currency)} left today</p>
      </div>

      <dl className="mx-3 mt-3 divide-y divide-cs-rule border-y border-cs-rule text-[11.5px]">
        {[
          ['Per invoice', money(m.perInvoiceCents, m.currency), false],
          ['Velocity', m.velocity, false],
          ['Valid until', `${m.expiresLabel}${expiring ? ` · ${daysLeft}d` : ''}`, expiring],
        ].map(([k, v, warn]) => (
          <div key={String(k)} className="flex items-center justify-between gap-2 py-1.5">
            <dt className="text-cs-soft">{k}</dt>
            <dd className={`font-semibold tabular-nums ${warn ? 'text-cs-held' : 'text-cs-ink'}`}>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex items-center justify-between px-3 py-2 text-[11px]">
        <span className="font-cs-mono text-cs-faint" title={`Mandate hash ${m.hash}`}>
          sig {m.hash.slice(0, 8)}
        </span>
        <span className="flex items-center gap-0.5 font-semibold text-cs-sign group-hover:text-cs-sign-deep">
          Manage <ChevronRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

function RailStatus({ simulation }: { simulation: boolean }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-cs-edge bg-cs-panel px-3 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[#003087] text-[11px] font-extrabold text-white" aria-hidden>
        P
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-xs font-semibold text-cs-ink">{simulation ? 'Simulation mode' : 'PayPal sandbox'}</span>
        <span className="block truncate text-[11px] text-cs-faint">{simulation ? 'Payouts are simulated' : 'Live API, test money'}</span>
      </span>
      <span className="relative flex size-2" role="img" aria-label={simulation ? 'Simulated' : 'Connected'}>
        {!simulation && <span className="absolute inline-flex size-full animate-ping rounded-full bg-cs-cleared opacity-60" />}
        <span className={`relative inline-flex size-2 rounded-full ${simulation ? 'bg-cs-held' : 'bg-cs-cleared'}`} />
      </span>
    </div>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--cs-sign)" />
      {/* A signature stroke under a check: the cosigner's mark. */}
      <path d="M9 16.5l4 4 9.5-10" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 25c3-1.6 5-1.6 7 0s4 1.6 9-.5" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// --- Menus --------------------------------------------------------------------------------------

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function Popover({ button, children, label, wide }: { button: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; label: string; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      {button(open, () => setOpen((v) => !v))}
      {open && (
        <div role="menu" aria-label={label} className={`cs-card cs-rise absolute right-0 z-40 mt-2 overflow-hidden ${wide ? 'w-[min(22rem,calc(100vw-2rem))]' : 'w-60'}`} style={{ boxShadow: 'var(--cs-shadow-lift)' }}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

const iconButton = 'relative flex size-10 items-center justify-center rounded-lg text-cs-soft hover:bg-cs-hover hover:text-cs-ink';

function NewMenu() {
  return (
    <Popover
      label="Create"
      button={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} className="hidden h-10 items-center gap-1.5 rounded-lg bg-cs-sign px-3.5 text-sm font-semibold text-cs-on-accent hover:bg-cs-sign-deep sm:flex">
          <Plus aria-hidden className="size-4" /> New <ChevronDown aria-hidden className="size-3.5 opacity-80" />
        </button>
      )}
    >
      {(close) => (
        <ul className="py-1.5 text-sm">
          {[
            { href: '/console/invoices/new', label: 'Invoice', hint: 'Read it and decide' },
            { href: '/console/milestones#new-deal', label: 'Milestone deal', hint: 'Pay for work in stages' },
            { href: '/console/mandate?tab=vendors', label: 'Approved vendor', hint: 'Who Cosign may pay' },
            { href: '/console/mandate', label: 'New mandate', hint: 'Change your limits' },
          ].map((i) => (
            <li key={i.href}>
              <Link href={i.href} onClick={close} role="menuitem" className="block px-4 py-2 hover:bg-cs-hover">
                <span className="font-semibold text-cs-ink">{i.label}</span>
                <span className="block text-xs text-cs-faint">{i.hint}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

const NOTICE_DOT = { held: 'bg-cs-held', blocked: 'bg-cs-blocked', sign: 'bg-cs-sign' } as const;

function Notifications({ notices }: { notices: Notice[] }) {
  return (
    <Popover
      label="Notifications"
      wide
      button={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-label={`Notifications${notices.length ? `, ${notices.length} new` : ''}`} className={iconButton}>
          <Bell className="size-5" />
          {notices.length > 0 && <span className="absolute top-2 right-2 size-2 rounded-full bg-cs-held ring-2 ring-cs-paper" />}
        </button>
      )}
    >
      {(close) => (
        <div>
          <p className="border-b border-cs-rule px-4 py-3 text-sm font-semibold">What needs you</p>
          {notices.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-cs-soft">Nothing needs you right now.</p>
          ) : (
            <ul className="cs-scroll max-h-96 divide-y divide-cs-rule overflow-y-auto">
              {notices.map((n, i) => (
                <li key={i}>
                  <Link href={n.href} onClick={close} className="flex gap-3 px-4 py-3 hover:bg-cs-hover">
                    <span className={`mt-1.5 size-2 shrink-0 rounded-full ${NOTICE_DOT[n.tone]}`} aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-cs-ink">{n.title}</span>
                      <span className="block truncate text-xs text-cs-soft">{n.body}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Popover>
  );
}

const subscribeTheme = (cb: () => void) => {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => o.disconnect();
};

function ThemeToggle() {
  // Read the theme the bootstrap script applied; server render assumes light.
  const dark = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme === 'dark', () => false);
  return (
    <button
      type="button"
      className={iconButton}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        const next = dark ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('cosign-theme', next);
        } catch {}
      }}
    >
      {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}

function UserMenu({ user, logout }: { user: string; logout: () => Promise<void> }) {
  const initials = user
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <Popover
      label="Account"
      button={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-label="Account" className="ml-1 flex size-10 items-center justify-center rounded-full bg-cs-sign-wash text-sm font-bold text-cs-sign-deep">
          {initials || '?'}
        </button>
      )}
    >
      {() => (
        <div className="py-1.5 text-sm">
          <p className="px-4 py-2">
            <span className="block font-semibold">{user}</span>
            <span className="block text-xs text-cs-faint">Owner. Your name goes on every approval.</span>
          </p>
          <form action={logout} className="border-t border-cs-rule pt-1.5">
            <button className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-cs-hover">
              <LogOut aria-hidden className="size-4 text-cs-faint" /> Sign out
            </button>
          </form>
        </div>
      )}
    </Popover>
  );
}

// --- Command palette ----------------------------------------------------------------------------

function Palette({ items, onClose }: { items: SearchItem[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = words.length ? items.filter((i) => words.every((w) => `${i.label} ${i.hint ?? ''} ${i.group}`.toLowerCase().includes(w))) : items.filter((i) => i.group === 'Pages' || i.group === 'Actions');
    return matched.slice(0, 30);
  }, [q, items]);
  const go = (i: SearchItem | undefined) => {
    if (!i) return;
    onClose();
    router.push(i.href);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
      <button type="button" aria-label="Close search" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="cs-card cs-rise relative w-full max-w-xl overflow-hidden" style={{ boxShadow: 'var(--cs-shadow-lift)' }}>
        <div className="flex items-center gap-3 border-b border-cs-rule px-4">
          <Search aria-hidden className="size-5 text-cs-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') go(results[index]);
              else if (e.key === 'Escape') onClose();
            }}
            placeholder="Search vendors, invoice numbers, amounts, pages"
            aria-label="Search"
            className="h-14 flex-1 bg-transparent text-base text-cs-ink outline-none placeholder:text-cs-faint focus-visible:outline-none"
          />
          <kbd className="rounded border border-cs-edge px-1.5 text-[11px] text-cs-faint">Esc</kbd>
        </div>
        <ul className="cs-scroll max-h-[50vh] overflow-y-auto py-2" role="listbox" aria-label="Results">
          {results.length === 0 && <li className="px-4 py-6 text-center text-sm text-cs-soft">No matches for “{q}”.</li>}
          {results.map((r, i) => {
            const header = i === 0 || results[i - 1].group !== r.group;
            return (
              <li key={`${r.group}-${r.href}-${i}`}>
                {header && <p className="px-4 pt-2 pb-1 text-xs font-semibold text-cs-faint">{r.group}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => go(r)}
                  className={`flex w-full items-center justify-between gap-4 px-4 py-2 text-left text-sm ${i === index ? 'bg-cs-sign-wash text-cs-sign-deep' : 'text-cs-ink'}`}
                >
                  <span className="truncate font-medium">{r.label}</span>
                  {r.hint && <span className="shrink-0 text-xs text-cs-faint">{r.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
