// Building blocks for the console. Server-safe (no hooks); client pieces live in ./client.tsx.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Ban, CircleCheck, Clock, Hourglass, Send, ServerCrash, Sparkles, type LucideIcon } from 'lucide-react';
import { REASON_LABEL, type Tone } from '@/lib/cosign-format';
import type { Reason } from '@/lib/cosign-types';
import { CosignError } from '@/lib/cosign-error';

const TONE_TEXT: Record<Tone, string> = {
  cleared: 'text-cs-cleared',
  held: 'text-cs-held',
  blocked: 'text-cs-blocked',
  neutral: 'text-cs-soft',
  sign: 'text-cs-sign',
};
const TONE_CHIP: Record<Tone, string> = {
  cleared: 'bg-cs-cleared-wash text-cs-cleared',
  held: 'bg-cs-held-wash text-cs-held',
  blocked: 'bg-cs-blocked-wash text-cs-blocked',
  neutral: 'bg-cs-rule text-cs-soft',
  sign: 'bg-cs-sign-wash text-cs-sign-deep',
};
const TONE_ICON: Record<Tone, LucideIcon> = { cleared: CircleCheck, held: Hourglass, blocked: Ban, neutral: Clock, sign: Send };

export function Stamp({ tone, children, sub, land, size = 'md' }: { tone: Tone; children: ReactNode; sub?: ReactNode; land?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-xs' : 'text-lg';
  return (
    <span className={`cs-stamp ${sz} ${TONE_TEXT[tone]} ${land ? 'cs-stamp-land' : ''}`}>
      {children}
      {sub && <small>{sub}</small>}
    </span>
  );
}

/** Status chip: colour plus an icon, so state never depends on colour alone. */
export function Chip({ tone, children, icon = true }: { tone: Tone; children: ReactNode; icon?: boolean }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${TONE_CHIP[tone]}`}>
      {icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </span>
  );
}

export function PageHead({ title, lede, actions, eyebrow }: { title: string; lede?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {eyebrow && <div className="mb-1 text-sm text-cs-soft">{eyebrow}</div>}
        <h1 className="text-2xl leading-tight font-bold tracking-tight text-cs-ink sm:text-[1.75rem]">{title}</h1>
        {lede && <p className="mt-1.5 text-[0.95rem] leading-relaxed text-cs-soft">{lede}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, aside, children, className = '', id }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`mt-8 scroll-mt-24 ${className}`}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-base font-bold text-cs-ink">{title}</h2>
        {aside && <div className="text-sm text-cs-soft">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className = '', title, aside }: { children: ReactNode; className?: string; title?: ReactNode; aside?: ReactNode }) {
  return (
    <div className={`cs-card ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-cs-rule px-5 py-3.5">
          <h2 className="text-sm font-bold text-cs-ink">{title}</h2>
          {aside && <div className="text-sm">{aside}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

const BUTTON = {
  primary: 'bg-cs-sign text-cs-on-accent hover:bg-cs-sign-deep',
  quiet: 'border border-cs-edge bg-cs-paper text-cs-ink hover:bg-cs-hover',
  ghost: 'text-cs-sign hover:bg-cs-sign-wash',
} as const;

export function ButtonLink({ href, children, variant = 'primary', className = '' }: { href: string; children: ReactNode; variant?: keyof typeof BUTTON; className?: string }) {
  return (
    <Link href={href} className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold ${BUTTON[variant]} ${className}`}>
      {children}
    </Link>
  );
}

/** Vendor initials on a colour picked from the name, so the same vendor always looks the same. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const hues = [222, 160, 30, 280, 195, 340, 100, 250];
  const h = hues[[...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % hues.length];
  const initials = name
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${size === 'sm' ? 'size-8 text-xs' : 'size-10 text-sm'}`}
      style={{ background: `hsl(${h} 70% 92%)`, color: `hsl(${h} 55% 30%)` }}
    >
      {initials || '?'}
    </span>
  );
}

/** Why a decision went the way it did: one line per reason, rules and agent flags told apart. */
export function Reasons({ reasons, empty = 'No rule objected.' }: { reasons: Reason[]; empty?: string }) {
  if (!reasons.length) return <p className="text-sm text-cs-soft">{empty}</p>;
  return (
    <ul className="space-y-3">
      {reasons.map((r, i) => (
        <li key={i} className="flex gap-3 text-sm leading-snug">
          <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${r.source === 'agent' ? 'bg-cs-sign-wash text-cs-sign' : 'bg-cs-rule text-cs-soft'}`} aria-hidden>
            {r.source === 'agent' ? <Sparkles className="size-3" /> : <span className="text-[10px] font-bold">§</span>}
          </span>
          <span className="min-w-0">
            <span className="font-semibold text-cs-ink">{REASON_LABEL[r.code] ?? r.code}</span>
            <span className="ml-2 text-xs text-cs-faint">{r.source === 'agent' ? 'Flagged by the AI' : 'Your rule'}</span>
            <span className="block break-words text-cs-soft">{r.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // Helper text sits under the control, so inputs in the same row line up whether or not
    // their neighbours have a hint.
    <label className="block">
      <span className="block text-sm font-semibold text-cs-ink">{label}</span>
      <span className="mt-1.5 block">{children}</span>
      {hint && <span className="mt-1 block text-xs text-cs-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-cs-edge bg-cs-paper px-3 py-2 text-sm text-cs-ink placeholder:text-cs-faint focus:border-cs-sign focus:ring-2 focus:ring-cs-sign/20 focus:outline-none';

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-cs-blocked/30 bg-cs-blocked-wash px-3 py-2 text-sm text-cs-blocked">
      {children}
    </p>
  );
}

export function Empty({ title, children, icon: Icon = Sparkles, action }: { title: string; children?: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="cs-card flex flex-col items-center px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-cs-sign-wash text-cs-sign">
        <Icon aria-hidden className="size-6" />
      </span>
      <p className="mt-4 font-semibold text-cs-ink">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-cs-soft">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Hash({ value, n = 12 }: { value: string | null | undefined; n?: number }) {
  if (!value) return null;
  const v = value.replace(/^sha256:/, '');
  return (
    <code className="cs-hash text-cs-soft" title={v}>
      {v.slice(0, n)}
    </code>
  );
}

export function CoreDown({ error }: { error: unknown }) {
  return (
    <div className="mx-auto max-w-xl pt-10">
      <Empty title="Cosign core is not reachable" icon={ServerCrash}>
        <p className="mt-1 text-cs-blocked">{error instanceof CosignError ? error.message : String(error)}</p>
        <p className="mt-3">
          Start everything with <code className="cs-hash">docker compose -f deploy/docker-compose.yml up</code>, or run the core with <code className="cs-hash">cargo run</code> in{' '}
          <code className="cs-hash">core/</code>. Then check COSIGN_CORE_URL and CORE_OPERATOR_TOKEN in .env.local and reload.
        </p>
      </Empty>
    </div>
  );
}
