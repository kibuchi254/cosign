// A signed demo session cookie. One shared demo password (DEMO_PASSWORD) is enough for the
// hackathon; the cookie is HMAC-signed with SESSION_SECRET so it cannot be forged. Uses Web
// Crypto so the same code runs in proxy.ts and in server actions.

export const SESSION_COOKIE = 'cosign_session';
const MAX_AGE_S = 60 * 60 * 12;

export type Session = { name: string; exp: number };

const enc = new TextEncoder();

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET (16+ characters) must be set in production');
  return 'dev-only-session-secret-change-me';
}

export function demoPassword(): string {
  const p = process.env.DEMO_PASSWORD;
  if (p) return p;
  if (process.env.NODE_ENV === 'production') throw new Error('DEMO_PASSWORD must be set in production');
  return 'cosign';
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function sign(name: string): Promise<{ value: string; maxAge: number }> {
  const payload = b64url(enc.encode(JSON.stringify({ name, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S } satisfies Session)));
  return { value: `${payload}.${await hmac(payload)}`, maxAge: MAX_AGE_S };
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verify(cookie: string | undefined): Promise<Session | null> {
  if (!cookie) return null;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig || !safeEqual(sig, await hmac(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    return typeof s.name === 'string' && s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}
