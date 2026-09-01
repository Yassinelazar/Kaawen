// ============================================================
// Kaawn Companion — Stripe → entitlements bridge
// ============================================================
// Deploy as a Supabase Edge Function named `stripe-webhook` with
// JWT verification DISABLED (Stripe sends no Supabase JWT).
// Secret required (Edge Functions → Secrets):
//   STRIPE_WEBHOOK_SECRET = whsec_...   (from the Stripe webhook endpoint)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// This is the ONLY writer of plan='companion' and of the one-time guide
// flags — clients are barred by RLS (see entitlements-setup.sql).
// Events handled:
//   checkout.session.completed, reference "<uid>__birth"/"<uid>__charts"
//                                       → that guide flag, and nothing else
//   checkout.session.completed, bare "<uid>", not a one-time payment
//                                       → plan=companion
//   customer.subscription.updated       → refresh plan_expires_at
//   customer.subscription.deleted       → let the plan lapse at period end
//
// One-time guides never touch `plan`: buying the $4 Full Guide must not
// confer the Companion subscription (and vice versa).
//
// Expiry model: while the subscription is healthy, plan_expires_at is
// kept at current_period_end + 3 days of grace (so one missed webhook
// never locks a paying user out). On cancellation the grace is dropped
// and the plan ends when the paid period does.

const enc = new TextEncoder();

async function validSignature(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v;
    if (k === 'v1') v1.push(v);
  }
  if (!t || v1.length === 0) return false;
  // Replay guard: reject events signed more than 5 minutes ago.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time comparison against each provided v1 signature.
  return v1.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

async function db(path: string, method: string, body: unknown): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key!,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const payload = await req.text();
  const ok = await validSignature(
    payload, req.headers.get('stripe-signature'), Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '');
  if (!ok) return new Response('bad signature', { status: 400 });

  const event = JSON.parse(payload);
  const obj = event?.data?.object;
  if (!obj) return new Response('ok', { status: 200 });

  try {
    if (event.type === 'checkout.session.completed' && obj.client_reference_id) {
      // The site tags one-time guide checkouts as "<uid>__birth" /
      // "<uid>__charts"; a bare uid is the Companion subscription.
      const ref = String(obj.client_reference_id);
      const sep = ref.lastIndexOf('__');
      const userId = sep === -1 ? ref : ref.slice(0, sep);
      const guide  = sep === -1 ? '' : ref.slice(sep + 2);
      const isGuide = guide === 'birth' || guide === 'charts';

      // Only pay out what was actually paid for. The guide tag decides:
      // a guide-tagged session NEVER grants the Companion plan, whatever
      // its mode. (Mode is deliberately not consulted here — if a guide
      // is ever sold as a recurring price rather than a one-time charge,
      // the buyer must still receive what they paid for.) Only an
      // untagged reference can confer the subscription, and never from a
      // one-time payment.
      if (isGuide) {
        const column = guide === 'birth' ? 'guide_birth' : 'guide_charts';
        // Only the guide flag is written. stripe_customer_id is included
        // solely when Stripe actually made a customer — a one-time
        // Payment Link often does not, and writing null over a
        // subscriber's id would orphan their subscription events.
        const patch: Record<string, unknown> = { user_id: userId, [column]: true };
        if (obj.customer) patch.stripe_customer_id = obj.customer;
        await db('entitlements?on_conflict=user_id', 'POST', [patch]);
      } else if (!isGuide && obj.mode !== 'payment') {
        // Upsert: trial users already have a row; direct buyers may not.
        await db('entitlements?on_conflict=user_id', 'POST', [{
          user_id: userId,
          plan: 'companion',
          plan_expires_at: null, // subscription events set the real horizon
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.subscription,
        }]);
      }
    } else if (
      (event.type === 'customer.subscription.updated' ||
       event.type === 'customer.subscription.deleted') && obj.customer
    ) {
      const healthy = (obj.status === 'active' || obj.status === 'trialing') &&
        !obj.cancel_at_period_end && event.type !== 'customer.subscription.deleted';
      const periodEnd = obj.current_period_end
        ? new Date(obj.current_period_end * 1000)
        : new Date();
      const horizon = healthy
        ? new Date(periodEnd.getTime() + 3 * 86400000) // renewal grace
        : periodEnd;                                   // lapse when paid time ends
      await db(
        `entitlements?stripe_customer_id=eq.${encodeURIComponent(obj.customer)}`,
        'PATCH',
        { plan: 'companion', plan_expires_at: horizon.toISOString() },
      );
    }
  } catch (e) {
    // Non-2xx makes Stripe retry with backoff — the right behavior for
    // a transient database failure.
    return new Response(`db error: ${(e as Error).message}`, { status: 500 });
  }
  return new Response('ok', { status: 200 });
});
