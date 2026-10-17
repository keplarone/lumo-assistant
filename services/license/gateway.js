// Lumo's model gateway: the desktop app sends chat requests here and this server forwards them to
// OpenRouter with Lumo's own key, after checking the user's plan, its model list and its monthly
// allowance. The OpenRouter key never leaves the server. Configuration (environment variables):
//   OPENROUTER_API_KEY   OpenRouter API key (required for /api/chat)
//   OPENROUTER_API_BASE  optional, defaults to https://openrouter.ai/api/v1
//   Redis (see store.js) required: without it nothing can be metered, so chat is refused.
//   WHOP_API_KEY and friends (see validate.js) to check paid licenses.
//
// Who is asking: a signed-in person sends their Lumo account's access token as `Authorization: Bearer
// <AuthKit JWT>` (see accounts.js); usage then counts per account and the plan is the one linked to the
// account. Builds without accounts send a license key as the bearer instead (refused once that key is
// linked to an account), or nothing on Free. Every install also sends `X-Lumo-Install: <32 hex chars>`,
// a random id it made on first run. LUMO_REQUIRE_ACCOUNT=1 refuses callers that aren't signed in.

import { createHash } from 'node:crypto';
import { MODELS, plan as planById, publicCatalog, freeRoster } from './catalog.js';
import { validate } from './validate.js';
import { ACCOUNT_PLAN_TTL, accountPlanKey, accountTier } from './accounts.js';
import { membershipKey } from './links.js';
import { AuthError, verifyAccessToken } from './workos.js';

const INSTALL_ID = /^[a-f0-9]{32}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_BODY_BYTES = 4_000_000;
const MICRO = 1_000_000;
const DAY = 86_400;

const json = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const fail = (status, code, error, extra = {}) => json(status, { error, code, ...extra });
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** "2026-10": the UTC month usage counts toward. */
export const monthKey = (now) => now.toISOString().slice(0, 7);
/** Midnight UTC on the 1st of next month, when allowances reset. */
export const nextReset = (now) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

// ---- OpenRouter's model list (for the free roster), cached per function instance -------------------

let liveCache = { at: 0, models: null };
export function resetLiveCache() {
  liveCache = { at: 0, models: null };
}

async function liveModels(env, fetchImpl, now) {
  if (liveCache.models && now - liveCache.at < 3_600_000) return liveCache.models;
  try {
    const base = (env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const res = await fetchImpl(`${base}/models`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body?.data)) liveCache = { at: now, models: body.data };
    }
  } catch {}
  return liveCache.models;
}

// ---- Who is asking ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok: true, plan: import('./catalog.js').Plan, subject: string} | {ok: false, response: Response}>}
 */
async function identify(request, env, { store, fetchImpl, links, key }) {
  const install = (request.headers.get('x-lumo-install') || '').toLowerCase();
  if (!INSTALL_ID.test(install))
    return { ok: false, response: fail(400, 'invalid', 'This copy of Lumo did not identify itself.') };
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && JWT.test(bearer)) return identifyAccount(auth, env, { store, fetchImpl, links, key });
  if (env.LUMO_REQUIRE_ACCOUNT === '1')
    return { ok: false, response: fail(401, 'sign_in_required', 'Sign in to Lumo to continue.') };
  const licenseKey = bearer;
  if (!licenseKey) return { ok: true, plan: planById('free'), subject: `i:${install}` };
  // A license that belongs to an account works only for that account, so a shared key is useless.
  if (links && (await links.read(membershipKey(licenseKey)).catch(() => null)))
    return {
      ok: false,
      response: fail(403, 'sign_in_required', 'This license belongs to a Lumo account. Sign in to use it.'),
    };

  const cacheKey = `lic:${sha(licenseKey)}`;
  let tier = await store.get(cacheKey);
  if (tier === null) {
    const { status, body } = await validate(licenseKey, env, fetchImpl);
    if (status >= 500)
      return { ok: false, response: fail(503, 'unavailable', body.error || 'The license check is down.') };
    tier = body.valid ? body.tier : 'none';
    // A valid license is re-checked every 10 minutes, so a cancelled membership stops soon after.
    await store.set(cacheKey, tier, body.valid ? 600 : 60);
  }
  if (tier === 'none' || !['lite', 'pro'].includes(tier)) {
    return {
      ok: false,
      response: fail(
        403,
        'license_invalid',
        'Your Lumo license is no longer active. Check your membership on Whop, or remove the key in Settings → Plans to use Free.',
      ),
    };
  }
  return { ok: true, plan: planById(tier), subject: `m:${sha(licenseKey).slice(0, 32)}` };
}

/** A signed-in person: usage counts per account, and the plan is the account's linked membership. */
async function identifyAccount(auth, env, { store, fetchImpl, links, key }) {
  let who;
  try {
    who = await verifyAccessToken(auth, env, key);
  } catch (e) {
    return e instanceof AuthError
      ? { ok: false, response: fail(401, 'sign_in_required', e.message) }
      : { ok: false, response: fail(503, 'unavailable', 'Accounts are not set up on the server.') };
  }
  const cacheKey = accountPlanKey(who.userId);
  let tier = await store.get(cacheKey);
  if (tier === null) {
    if (!links)
      return { ok: false, response: fail(503, 'unavailable', 'Accounts are not set up on the server.') };
    tier = await accountTier(who.userId, { env, store: links, fetch: fetchImpl }).catch(() => null);
    if (tier === null)
      return {
        ok: false,
        response: fail(503, 'unavailable', 'The license check is down. Try again in a moment.'),
      };
    await store.set(cacheKey, tier, ACCOUNT_PLAN_TTL);
  }
  if (!['free', 'lite', 'pro'].includes(tier)) tier = 'free';
  return { ok: true, plan: planById(tier), subject: `u:${who.userId}` };
}

// ---- Usage -----------------------------------------------------------------------------------

async function readUsage(store, subject, plan, now) {
  const month = monthKey(now);
  const [spent, tokens] = await Promise.all([
    store.get(`spend:${subject}:${month}`),
    store.get(`tok:${subject}:${month}`),
  ]);
  const spentMicro = Math.max(0, Number(spent ?? 0));
  const tokensUsed = Math.max(0, Number(tokens ?? 0));
  const fraction =
    plan.monthlyBudgetUsd !== null
      ? spentMicro / (plan.monthlyBudgetUsd * MICRO)
      : tokensUsed / (plan.monthlyTokens ?? Infinity);
  return {
    plan: plan.id,
    planName: plan.name,
    percentUsed: Math.min(100, Math.round(fraction * 100)),
    resetsAt: nextReset(now),
    spentMicro,
    tokensUsed,
  };
}

function usageBody(u) {
  return { plan: u.plan, planName: u.planName, percentUsed: u.percentUsed, resetsAt: u.resetsAt };
}

function upgradeHint(plan) {
  if (plan.id === 'free') return ' Upgrade to Lumo Lite or Lumo Pro in Settings → Plans for much more.';
  if (plan.id === 'lite') return ' Upgrade to Lumo Pro in Settings → Plans for three times as much.';
  return '';
}

function resetDay(now) {
  return new Date(nextReset(now)).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ---- Model choice ----------------------------------------------------------------------------

/** The models to ask OpenRouter for, or an error Response. */
function chooseModels(plan, requested, free) {
  if (plan.models === 'free') {
    if (!free.length) return { error: fail(503, 'unavailable', 'No free models are available right now.') };
    const pick = free.find((m) => m.id === requested);
    const ordered = pick ? [pick, ...free.filter((m) => m !== pick)] : free;
    // OpenRouter tries the others in order when the first is busy.
    return { models: ordered.slice(0, 3) };
  }
  const id = !requested || requested === 'auto' ? plan.defaultModel : requested;
  if (!plan.models.includes(id)) {
    const known = MODELS[id];
    return {
      error: fail(
        403,
        'plan_limit',
        known
          ? `${known.name} is part of Lumo Pro. On ${plan.name}, choose another model in Settings → Model, or upgrade.`
          : 'That model is not available. Choose another one in Settings → Model.',
      ),
    };
  }
  return { models: [MODELS[id]] };
}

// ---- The request sent on --------------------------------------------------------------------

/** Rough tokens in the prompt: text at ~4 characters per token, images at ~1,600 tokens each. */
function estimatePromptTokens(messages) {
  let chars = 0;
  let images = 0;
  const walk = (v) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.type === 'image_url') images += 1;
      else Object.values(v).forEach(walk);
    }
  };
  walk(messages);
  return Math.ceil(chars / 4) + images * 1600;
}

/** Replace images with a note for models that can't see them. */
function withoutImages(messages) {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content.map((p) =>
            p?.type === 'image_url'
              ? { type: 'text', text: '[An image was here, but this model cannot see images.]' }
              : p,
          ),
        }
      : m,
  );
}

/** Anthropic models cache the system prompt (and tools) when asked, which makes repeat calls far cheaper. */
function withPromptCache(messages) {
  return messages.map((m, i) =>
    i === 0 && m.role === 'system' && typeof m.content === 'string'
      ? { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
      : m,
  );
}

function outgoingBody(body, models) {
  const primary = models[0];
  let messages = body.messages;
  if (!primary.vision) messages = withoutImages(messages);
  if (primary.id.startsWith('anthropic/')) messages = withPromptCache(messages);
  const out = {
    model: primary.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    usage: { include: true },
    max_tokens: Math.min(Number(body.max_tokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
  };
  if (models.length > 1) out.models = models.map((m) => m.id);
  if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools;
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  return out;
}

// ---- Streaming back, and settling the charge ------------------------------------------------

/** Reads OpenRouter's SSE stream as it passes through and keeps the final usage block. */
function usageWatcher() {
  const decoder = new TextDecoder();
  let buffer = '';
  const state = { usage: null };
  return {
    state,
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
        try {
          const d = JSON.parse(line.slice(5));
          if (d.usage && typeof d.usage === 'object') state.usage = d.usage;
        } catch {}
      }
    },
  };
}

// ---- Handlers --------------------------------------------------------------------------------

function deps(overrides = {}) {
  return {
    fetchImpl: overrides.fetchImpl ?? fetch,
    store: overrides.store,
    // Account links (links.js) and, in tests, the keys access tokens are signed with.
    links: overrides.links ?? null,
    key: overrides.key,
    now: overrides.now ?? (() => new Date()),
  };
}

/** GET /api/models: every plan's models, for the app's model picker and Plans screen. */
export async function models(env, overrides = {}) {
  const d = deps(overrides);
  const live = await liveModels(env, d.fetchImpl, d.now().getTime());
  return json(200, publicCatalog(live), { 'Cache-Control': 'public, max-age=300' });
}

/** GET /api/usage: the caller's plan and how much of this month's allowance is used. */
export async function usage(request, env, overrides = {}) {
  const d = deps(overrides);
  if (!d.store) return fail(503, 'unavailable', 'Usage tracking is not configured on the server.');
  const who = await identify(request, env, d);
  if (!who.ok) return who.response;
  return json(200, usageBody(await readUsage(d.store, who.subject, who.plan, d.now())));
}

/** POST /api/chat: an OpenAI-style chat completion request, streamed back as server-sent events. */
export async function chat(request, env, overrides = {}) {
  const d = deps(overrides);
  if (!env.OPENROUTER_API_KEY || !d.store)
    return fail(503, 'unavailable', 'Lumo’s models are not set up on the server yet.');
  const now = d.now();
  const who = await identify(request, env, d);
  if (!who.ok) return who.response;
  const { plan, subject } = who;

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES)
    return fail(413, 'invalid', 'This conversation is too large to send. Start a new one.');
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'invalid', 'Expected a JSON body.');
  }
  if (!Array.isArray(body?.messages) || !body.messages.length)
    return fail(400, 'invalid', 'The request has no messages.');

  // Abuse limits: per user per minute, and for Free a share of the account-wide free-model limit.
  const minute = Math.floor(now.getTime() / 60_000);
  if ((await d.store.incr(`rpm:${subject}:${minute}`, 1, 120)) > plan.requestsPerMinute)
    return fail(429, 'rate_limited', 'Lumo is going a bit fast. Try again in a minute.', { retryAfter: 60 });
  if (plan.requestsPerDay !== null) {
    const day = now.toISOString().slice(0, 10);
    if ((await d.store.incr(`rpd:${subject}:${day}`, 1, 2 * DAY)) > plan.requestsPerDay)
      return fail(
        429,
        'plan_limit',
        `You've reached today's Free limit. It resets at midnight UTC.${upgradeHint(plan)}`,
      );
  }

  const before = await readUsage(d.store, subject, plan, now);
  if (before.percentUsed >= 100)
    return fail(
      402,
      'plan_limit',
      `You've used all of this month's ${plan.name.replace('Lumo ', '')} usage. It resets on ${resetDay(now)}.${upgradeHint(plan)}`,
      { usage: usageBody(before) },
    );

  const live = plan.models === 'free' ? await liveModels(env, d.fetchImpl, now.getTime()) : null;
  const chosen = chooseModels(plan, typeof body.model === 'string' ? body.model : '', freeRoster(live));
  if (chosen.error) return chosen.error;
  const out = outgoingBody(body, chosen.models);

  // Reserve the most this call could cost before it runs, then settle on what OpenRouter reports.
  // If the user stops mid-answer and no cost arrives, the reservation stands.
  const month = monthKey(now);
  const spendKey = `spend:${subject}:${month}`;
  const tokKey = `tok:${subject}:${month}`;
  const primary = chosen.models[0];
  const reserved =
    plan.monthlyBudgetUsd === null
      ? 0
      : // Prices are dollars per million tokens, so tokens × price is micro-dollars.
        Math.ceil(estimatePromptTokens(out.messages) * primary.input + out.max_tokens * primary.output);
  if (reserved) await d.store.incr(spendKey, reserved, 40 * DAY);

  const base = (env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  let upstream;
  try {
    upstream = await d.fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://lumo.keplar.one',
        'X-Title': 'Lumo',
      },
      body: JSON.stringify({ ...out, user: subject }),
      signal: request.signal,
    });
  } catch {
    if (reserved) await d.store.incr(spendKey, -reserved, 40 * DAY);
    return fail(502, 'unavailable', 'Could not reach the model service. Try again in a moment.');
  }
  if (!upstream.ok || !upstream.body) {
    if (reserved) await d.store.incr(spendKey, -reserved, 40 * DAY);
    const status = upstream.status;
    if (status === 429)
      return fail(
        429,
        'rate_limited',
        plan.id === 'free'
          ? `The free models are busy right now. Try again in a minute.${upgradeHint(plan)}`
          : 'The model is busy right now. Try again in a minute.',
        { retryAfter: 30 },
      );
    if (status === 402) {
      console.error('OpenRouter is out of credits: top up, or check auto top-up and the key limit');
      return fail(503, 'unavailable', 'Lumo’s models are paused for a moment. Try again shortly.');
    }
    if (status === 400) {
      const text = await upstream.text().catch(() => '');
      return fail(400, 'invalid', `The model could not read this request. ${text.slice(0, 300)}`);
    }
    return fail(502, 'unavailable', `The model service answered with HTTP ${status}. Try again in a moment.`);
  }

  const watcher = usageWatcher();
  const reader = upstream.body.getReader();
  let settled = false;
  const settle = async (reported) => {
    if (settled) return;
    settled = true;
    try {
      if (reported) {
        const tokens = (Number(reported.prompt_tokens) || 0) + (Number(reported.completion_tokens) || 0);
        const costMicro = Math.round((Number(reported.cost) || 0) * MICRO);
        if (plan.monthlyBudgetUsd !== null && costMicro !== reserved)
          await d.store.incr(spendKey, costMicro - reserved, 40 * DAY);
        if (tokens) await d.store.incr(tokKey, tokens, 40 * DAY);
      }
    } catch (e) {
      console.error('could not record usage', e);
    }
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await settle(watcher.state.usage);
          controller.close();
          return;
        }
        watcher.push(value);
        controller.enqueue(value);
      } catch (e) {
        await settle(watcher.state.usage);
        controller.error(e);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
      await settle(watcher.state.usage);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Lumo-Plan': plan.id,
      'X-Lumo-Model': primary.id,
      'X-Lumo-Usage-Percent': String(before.percentUsed),
    },
  });
}
