'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import { toast } from './toast';

type Variant = 'primary' | 'quiet' | 'danger' | 'success';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-cs-sign text-cs-on-accent hover:bg-cs-sign-deep disabled:opacity-60',
  success: 'bg-cs-cleared text-cs-on-accent hover:opacity-90 disabled:opacity-60',
  quiet: 'border border-cs-edge bg-cs-paper text-cs-ink hover:bg-cs-hover disabled:text-cs-faint',
  danger: 'border border-cs-blocked/40 bg-cs-paper text-cs-blocked hover:bg-cs-blocked-wash disabled:text-cs-faint',
};

/** A submit button that shows the action in progress ("Signing…") while the server works. */
export function Submit({
  children,
  pending,
  variant = 'primary',
  name,
  value,
  disabled,
  className = '',
  size = 'md',
}: {
  children: ReactNode;
  pending: string;
  variant?: Variant;
  name?: string;
  value?: string;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const { pending: busy, data } = useFormStatus();
  // With several submit buttons in one form, only the one pressed shows its progress label.
  const mine = busy && (!name || data?.get(name) === value);
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={busy || disabled}
      aria-busy={mine}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed ${size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm'} ${VARIANT[variant]} ${className}`}
    >
      {mine && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
      {mine ? pending : children}
    </button>
  );
}

/** Shows each new result of a server action as a toast, once. */
export function useActionToast(state: { ok: boolean; message: string; warn?: boolean } | null, successTitle = 'Done') {
  const last = useRef<typeof state>(null);
  useEffect(() => {
    if (!state || state === last.current) return;
    last.current = state;
    toast(state.ok ? { tone: state.warn ? 'warning' : 'success', title: successTitle, body: state.message } : { tone: 'error', title: 'That did not go through', body: state.message });
  }, [state, successTitle]);
}

type Result = { ok: boolean; message: string; warn?: boolean } | null;

/**
 * Wraps a server action for <form action>: runs it, then toasts the result. The toast is raised
 * here, not from component state, so it still shows when the action removes the form itself
 * (an approved payment leaving the inbox).
 */
export function withToast<S extends Result>(act: (prev: S, f: FormData) => Promise<S>, successTitle: string, onDone?: (r: NonNullable<S>) => void) {
  return async (f: FormData) => {
    const r = await act(null as S, f);
    if (r) toast(r.ok ? { tone: r.warn ? 'warning' : 'success', title: successTitle, body: r.message } : { tone: 'error', title: 'That did not go through', body: r.message });
    if (r && onDone) onDone(r);
  };
}
