'use client';

// Toasts: a confirmation for every action, in the same words as the button that caused it.
// Any client component calls toast(); the Toaster in the console layout shows it.

import { CircleAlert, CircleCheck, Hourglass, Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';
type Toast = { id: number; tone: ToastTone; title: string; body?: string };

const EVENT = 'cosign:toast';
let next = 1;

export function toast(t: Omit<Toast, 'id'>) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { ...t, id: next++ } }));
}

const ICON = { success: CircleCheck, error: CircleAlert, info: Info, warning: Hourglass } as const;
const TONE = { success: 'text-cs-cleared', error: 'text-cs-blocked', info: 'text-cs-sign', warning: 'text-cs-held' } as const;

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setItems((xs) => [...xs.slice(-3), t]);
      window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.tone === 'error' ? 9000 : 5000);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-20 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 md:bottom-6">
      {items.map((t) => {
        const Icon = ICON[t.tone];
        return (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="cs-card cs-rise pointer-events-auto flex gap-3 p-4" style={{ boxShadow: 'var(--cs-shadow-lift)' }}>
            <Icon aria-hidden className={`mt-0.5 size-5 shrink-0 ${TONE[t.tone]}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-cs-ink">{t.title}</p>
              {t.body && <p className="mt-0.5 text-sm break-words text-cs-soft">{t.body}</p>}
            </div>
            <button type="button" aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} className="text-cs-faint hover:text-cs-ink">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
