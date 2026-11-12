import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verify } from '@/lib/session';

// Everything behind the demo login: the Cosign console, the AG Studio dashboard, the PayPal
// endpoint pages and the AI proxy. The landing page and /login stay public.
export async function proxy(request: NextRequest) {
  const session = await verify(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  }
  const login = new URL('/login', request.url);
  login.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/console/:path*', '/dashboard/:path*', '/paypal/:path*', '/products', '/plans', '/invoices', '/transactions', '/balances', '/api/:path*'],
};
