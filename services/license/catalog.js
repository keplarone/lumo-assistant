// What each Lumo plan includes on the server: its monthly allowance and which OpenRouter models it may use.
// The desktop app reads this through GET /api/models, so models can change without an app release.
//
// Allowances are what the plan costs Lumo, not what it charges: paid plans get a monthly budget in US
// dollars of OpenRouter usage (OpenRouter reports the exact cost of every call), and Free gets a token
// allowance on OpenRouter's free models, which cost nothing but share one account-wide rate limit.
// The app shows either one as "X% used this month". Prices below are per million tokens and are used
// only to estimate a call before it runs; the charge is always the cost OpenRouter reports.
// `pnpm --filter @lumo/license check-models` compares this table with OpenRouter's live model list.

/** @typedef {{id: string, name: string, blurb: string, vision: boolean, input: number, output: number}} Model */

/** @type {Record<string, Model>} */
export const MODELS = {
  'anthropic/claude-haiku-5.5': {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    blurb: 'Fast and careful. Great for everyday tasks.',
    vision: true,
    input: 0.1,
    output: 0.5,
  },
  'openai/gpt-6-luna': {
    id: 'openai/gpt-6-luna',
    name: 'GPT-6 Luna',
    blurb: 'Quick answers and light tasks.',
    vision: true,
    input: 0.1,
    output: 0.5,
  },
  'anthropic/claude-sonnet-5.5': {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    blurb: 'The strongest at long, many-step tasks and using your computer.',
    vision: true,
    input: 2,
    output: 10,
  },
  'openai/gpt-6-sol': {
    id: 'openai/gpt-6-sol',
    name: 'GPT-6 Sol',
    blurb: 'Strong at writing, research and planning.',
    vision: true,
    input: 2,
    output: 10,
  },
  'google/gemini-4-argon': {
    id: 'google/gemini-4-argon',
    name: 'Gemini 4 Argon',
    blurb: 'Reads long documents and images well.',
    vision: true,
    input: 2,
    output: 10,
  },
};

// OpenRouter's free models come and go, so Free names the ones Lumo prefers, in order, and the server
// keeps only those OpenRouter still lists as free with tool calling (see `freeRoster`). If none of them
// is left, it falls back to any free model that supports tools.
export const FREE_PREFERRED = [
  'nvidia/nemotron-3.5-super-vl:free',
  'meta-llama/llama-4-maverick:free',
  'xingchen-agi/xing4.0-29b-a4b:free',
];

/**
 * @typedef {{
 *   id: 'free' | 'lite' | 'pro', name: string, priceUsd: number,
 *   monthlyBudgetUsd: number | null, monthlyTokens: number | null,
 *   requestsPerDay: number | null, requestsPerMinute: number,
 *   models: string[] | 'free', defaultModel: string | null,
 * }} Plan
 */

/** @type {Plan[]} Cheapest first. */
export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    monthlyBudgetUsd: null,
    monthlyTokens: 1_000_000,
    // Every Free user shares OpenRouter's free-model limit (1,000 requests a day for the whole account),
    // so each Free install gets a small share of it.
    requestsPerDay: 60,
    requestsPerMinute: 10,
    models: 'free',
    defaultModel: null,
  },
  {
    id: 'lite',
    name: 'Lumo Lite',
    priceUsd: 19.99,
    monthlyBudgetUsd: 6,
    monthlyTokens: null,
    requestsPerDay: null,
    requestsPerMinute: 30,
    models: ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'],
    defaultModel: 'anthropic/claude-haiku-5.5',
  },
  {
    id: 'pro',
    name: 'Lumo Pro',
    priceUsd: 49.99,
    monthlyBudgetUsd: 18,
    monthlyTokens: null,
    requestsPerDay: null,
    requestsPerMinute: 40,
    models: [
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6-sol',
      'openai/gpt-6-luna',
      'google/gemini-4-argon',
    ],
    defaultModel: 'anthropic/claude-sonnet-5.5',
  },
];

/** @param {string} id */
export function plan(id) {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

/**
 * Free models OpenRouter currently offers with tool calling, best first.
 * @param {Array<{id: string, pricing?: {prompt?: string, completion?: string}, supported_parameters?: string[], architecture?: {input_modalities?: string[]}, context_length?: number}> | null} live
 *   OpenRouter's model list, or null when it could not be fetched.
 * @returns {Array<{id: string, name: string, blurb: string, vision: boolean}>}
 */
export function freeRoster(live) {
  const describe = (m) => ({
    id: m.id,
    name: freeName(m.id),
    blurb: 'Free model. Can be slow or busy at peak times.',
    vision: !!m.architecture?.input_modalities?.includes('image'),
  });
  if (!live) return FREE_PREFERRED.map((id) => ({ ...describe({ id }), vision: false }));
  const usable = live.filter(
    (m) =>
      m.id.endsWith(':free') &&
      Number(m.pricing?.prompt ?? 1) === 0 &&
      Number(m.pricing?.completion ?? 1) === 0 &&
      (m.supported_parameters ?? []).includes('tools'),
  );
  const preferred = FREE_PREFERRED.map((id) => usable.find((m) => m.id === id)).filter(Boolean);
  if (preferred.length) return preferred.map(describe);
  const bySize = [...usable].sort(
    (a, b) =>
      Number(!!b.architecture?.input_modalities?.includes('image')) -
        Number(!!a.architecture?.input_modalities?.includes('image')) ||
      (b.context_length ?? 0) - (a.context_length ?? 0),
  );
  return bySize.slice(0, 3).map(describe);
}

/** "nvidia/nemotron-3.5-super-vl:free" -> "Nemotron 3.5 Super VL" */
function freeName(id) {
  const base = id
    .split('/')
    .pop()
    .replace(/:free$/, '');
  return base
    .split('-')
    .map((w) => (/^vl$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** The plan table as the app sees it (no prices per token, no internal limits). */
export function publicCatalog(live) {
  const free = freeRoster(live);
  return {
    plans: PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      priceUsd: p.priceUsd,
      defaultModel: p.models === 'free' ? (free[0]?.id ?? null) : p.defaultModel,
      models:
        p.models === 'free'
          ? free
          : p.models.map((id) => {
              const m = MODELS[id];
              return { id: m.id, name: m.name, blurb: m.blurb, vision: m.vision };
            }),
    })),
  };
}
