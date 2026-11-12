// PayPal webhooks arrive at the public web domain and are passed to the core unchanged, so the
// whole app can run behind one domain while the core stays private. The core verifies the
// signature against the raw body and PayPal's transmission headers, so both are forwarded as-is.
// This route holds no secret and makes no decision.

const FORWARD = ['content-type', 'paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time', 'paypal-auth-version'];
const MAX_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const body = await request.text();
  if (body.length > MAX_BYTES) return Response.json({ error: 'payload too large' }, { status: 413 });
  const headers = new Headers();
  for (const h of FORWARD) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const core = (process.env.COSIGN_CORE_URL || 'http://localhost:8080').replace(/\/+$/, '');
  try {
    const r = await fetch(`${core}/webhooks/paypal`, { method: 'POST', headers, body, cache: 'no-store' });
    return new Response(await r.text(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
  } catch {
    // PayPal retries on a 5xx, so a brief core outage loses nothing.
    return Response.json({ error: 'core unavailable' }, { status: 503 });
  }
}
