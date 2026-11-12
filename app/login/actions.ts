'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, demoPassword, safeEqual, sign } from '@/lib/session';

export async function login(_: { message: string } | null, form: FormData): Promise<{ message: string } | null> {
  const name = String(form.get('name') ?? '').trim().slice(0, 60);
  const password = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/console');
  if (!name) return { message: 'Enter your name.' };
  if (!safeEqual(password, demoPassword())) return { message: 'That password is not right. Check the README for the demo password.' };
  const { value, maxAge } = await sign(name);
  (await cookies()).set(SESSION_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge });
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/console');
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}
