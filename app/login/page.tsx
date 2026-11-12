import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '../console/shell';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const next = (await searchParams).next;
  const target = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/console';
  return (
    <main className="cosign cs-security flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center justify-center gap-2.5 text-xl font-extrabold tracking-tight text-cs-ink">
          <Logo /> Cosign
        </Link>
        <div className="cs-card mt-6 p-7" style={{ boxShadow: 'var(--cs-shadow-lift)' }}>
          <h1 className="text-xl font-bold">Sign in to the demo</h1>
          <p className="mt-1 text-sm text-cs-soft">Use the demo password from the README. Your name is recorded on everything you approve.</p>
          <LoginForm next={target} />
        </div>
      </div>
    </main>
  );
}
