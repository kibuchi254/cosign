'use client';

import { useActionState } from 'react';
import { Submit } from '../console/client';
import { ErrorNote, Field, inputClass } from '../console/ui';
import { login } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(login, null);
  return (
    <form action={action} className="mt-5 space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Your name" hint="Shown on approvals in the audit log">
        <input name="name" required maxLength={60} autoComplete="name" defaultValue="Demo owner" className={inputClass} />
      </Field>
      <Field label="Demo password">
        <input name="password" type="password" required autoComplete="current-password" className={inputClass} />
      </Field>
      {state?.message && <ErrorNote>{state.message}</ErrorNote>}
      <Submit pending="Signing in…" className="w-full">
        Sign in
      </Submit>
    </form>
  );
}
