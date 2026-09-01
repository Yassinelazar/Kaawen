// ============================================================
// Kaawen — Stripe Checkout Session for the one-time guides
// ============================================================
// Deploy as a Supabase Edge Function named `create-checkout` with JWT
// verification ENABLED: the caller must be a signed-in Supabase user so
// the purchase can be bound to their account.
//
// Secret required (Edge Functions → Secrets):
//   STRIPE_SECRET_KEY = sk_live_...   (or sk_test_... while rehearsing)
// SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.
//
// Why a session rather than a Payment Link: the session carries
// client_reference_id ("<uid>__birth" / "<uid>__charts") that
// stripe-webhook reads to record the purchase against the account. A
// Payment Link can carry it too, but only if every share of the link
// remembers to append it — a session cannot forget.
//
// The price's own shape decides the mode: a recurring price opens a
// subscription checkout, a one-time price a payment checkout. So the
// prices can be switched between the two in the Stripe dashboard
// without touching this function.

// Products, not prices: the active price is resolved at request time, so
// changing what a guide costs is a dashboard edit with no redeploy. The
// resolved product's name is returned to the caller for verification.
const PRODUCTS: Record<string, string> = {
  birth:  'prod_VB8XkBUl0ZkRfL',
  charts: 'prod_VB8XiLHGwgbvaN',
};

const SITE = 'https://kaawen.com/';

// The browser's preflight asks for every header the client sends —
// supabase-js and our fetch both add `apikey` (and x-client-info), so
// omitting them here makes the preflight fail and the POST never runs.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Stripe's REST API takes form encoding, including for nested fields.
async function stripe(path: string, key: string, form?: Record<string, string>): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `stripe ${res.status}`);
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) return json({ error: 'checkout not configured' }, 503);

  let guide = '';
  try { guide = String((await req.json())?.guide || ''); } catch { /* fall through */ }
  const product = PRODUCTS[guide];
  if (!product) return json({ error: 'unknown guide' }, 400);

  // Identify the buyer from their Supabase session.
  const auth = req.headers.get('Authorization') || '';
  const who = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  });
  if (!who.ok) return json({ error: 'not signed in' }, 401);
  const user = await who.json();
  if (!user?.id) return json({ error: 'not signed in' }, 401);

  try {
    // The product's current active price, and its shape decides the mode:
    // a recurring price opens a subscription checkout, a one-time price a
    // payment checkout — so either pricing model works untouched.
    const list = await stripe(`prices?product=${product}&active=true&limit=1`, key);
    const priceObj = list?.data?.[0];
    if (!priceObj) return json({ error: `no active price on ${product}` }, 500);
    const mode = priceObj.recurring ? 'subscription' : 'payment';

    const session = await stripe('checkout/sessions', key, {
      mode,
      'line_items[0][price]': priceObj.id,
      'line_items[0][quantity]': '1',
      client_reference_id: `${user.id}__${guide}`,
      success_url: `${SITE}?guide=${guide}`,
      cancel_url: SITE,
      allow_promotion_codes: 'true',
    });
    // amount/livemode echoed back so the wiring can be verified from the
    // client without opening the Stripe dashboard.
    return json({
      url: session.url,
      amount: priceObj.unit_amount,
      recurring: !!priceObj.recurring,
      livemode: !!session.livemode,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
