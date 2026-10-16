// Whop license check for Lumo. The Whop API key lives only here, on the server; the desktop app sends a
// license key and gets back a plan tier. Configuration (environment variables):
//   WHOP_API_KEY        Whop account API key with member:basic:read and member:email:read (required)
//   WHOP_PLANS_LITE     optional comma-separated Whop plan ids that grant Lumo Lite (default below)
//   WHOP_PLANS_PRO      optional comma-separated Whop plan ids that grant Lumo Pro (default below)
//   WHOP_API_BASE       optional, defaults to https://api.whop.com/api/v1

const VALID_STATUSES = new Set(['active', 'trialing', 'completed', 'past_due', 'canceling']);
export const DEFAULT_PLANS = { lite: 'plan_0KzI2YIP7k6Pp', pro: 'plan_1ucbcMEoxhW3g' };
const KEY_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

const list = (v) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * @param {string} licenseKey
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{status: number, body: object}>}
 */
export async function validate(licenseKey, env, fetchImpl = fetch) {
  if (!env.WHOP_API_KEY)
    return { status: 503, body: { valid: false, error: 'Licensing is not configured on the server.' } };
  if (typeof licenseKey !== 'string' || !KEY_PATTERN.test(licenseKey)) {
    return { status: 400, body: { valid: false, error: 'That does not look like a license key.' } };
  }
  const base = (env.WHOP_API_BASE || 'https://api.whop.com/api/v1').replace(/\/$/, '');
  let res;
  try {
    res = await fetchImpl(`${base}/memberships/${encodeURIComponent(licenseKey)}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}`, Accept: 'application/json' },
    });
  } catch {
    return { status: 502, body: { valid: false, error: 'Could not reach Whop.' } };
  }
  if (res.status === 404) return { status: 200, body: { valid: false, error: 'License key not found.' } };
  if (!res.ok)
    return { status: 502, body: { valid: false, error: `Whop answered with HTTP ${res.status}.` } };
  let m;
  try {
    m = await res.json();
  } catch {
    return { status: 502, body: { valid: false, error: 'Whop sent an unreadable answer.' } };
  }
  const planId = m?.plan?.id ?? null;
  const tier = list(env.WHOP_PLANS_PRO || DEFAULT_PLANS.pro).includes(planId)
    ? 'pro'
    : list(env.WHOP_PLANS_LITE || DEFAULT_PLANS.lite).includes(planId)
      ? 'lite'
      : null;
  if (!VALID_STATUSES.has(m?.status)) {
    return {
      status: 200,
      body: { valid: false, membershipStatus: m?.status ?? null, error: 'This membership is not active.' },
    };
  }
  if (!tier)
    return {
      status: 200,
      body: { valid: false, membershipStatus: m.status, error: 'This membership is not for a Lumo plan.' },
    };
  return { status: 200, body: { valid: true, tier, membershipStatus: m.status } };
}
