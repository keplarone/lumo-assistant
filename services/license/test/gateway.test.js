import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chat, usage, models, resetLiveCache, nextReset } from '../gateway.js';
import { memoryStore } from '../store.js';
import { PLANS } from '../catalog.js';

const INSTALL = 'a'.repeat(32);
const env = { OPENROUTER_API_KEY: 'or-key', WHOP_API_KEY: 'whop-key' };
const now = () => new Date('2026-10-16T12:00:00Z');

const LIVE = [
  {
    id: 'nvidia/nemotron-3.5-super-vl:free',
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools'],
    architecture: { input_modalities: ['text', 'image'] },
  },
  {
    id: 'xingchen-agi/xing4.0-29b-a4b:free',
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools'],
    architecture: { input_modalities: ['text'] },
  },
  {
    id: 'someone/no-tools:free',
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: [],
    architecture: { input_modalities: ['text'] },
  },
];

const sse = (usageBlock) =>
  [
    `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'Hi' } }] })}`,
    ': OPENROUTER PROCESSING',
    ...(usageBlock ? [`data: ${JSON.stringify({ id: 'gen-1', choices: [], usage: usageBlock })}`] : []),
    'data: [DONE]',
    '',
  ].join('\n\n');

/** A fake network: Whop memberships, OpenRouter's model list and chat completions. */
function network({
  membership = { status: 'active', plan: { id: 'plan_0KzI2YIP7k6Pp' } },
  chatStatus = 200,
  usageBlock,
} = {}) {
  const calls = { whop: 0, chat: [], models: 0 };
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://api.whop.com/')) {
      calls.whop += 1;
      assert.equal(init.headers.Authorization, 'Bearer whop-key');
      return Response.json(membership);
    }
    if (url === 'https://openrouter.ai/api/v1/models') {
      calls.models += 1;
      return Response.json({ data: LIVE });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      assert.equal(init.headers.Authorization, 'Bearer or-key');
      calls.chat.push(JSON.parse(init.body));
      if (chatStatus !== 200) return new Response('busy', { status: chatStatus });
      return new Response(sse(usageBlock ?? { prompt_tokens: 1000, completion_tokens: 200, cost: 0.0012 }), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

const request = (body, { license, install = INSTALL } = {}) =>
  new Request('https://lumo-license.vercel.app/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(install ? { 'X-Lumo-Install': install } : {}),
      ...(license ? { Authorization: `Bearer ${license}` } : {}),
    },
    body: JSON.stringify(body),
  });

const hello = {
  model: 'auto',
  messages: [
    { role: 'system', content: 'You are Lumo.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ],
  tools: [{ type: 'function', function: { name: 'list_directory', parameters: { type: 'object' } } }],
  max_tokens: 32000,
  // Ignored: the client can't pick providers, plugins or routing.
  provider: { order: ['x'] },
  plugins: [{ id: 'web' }],
  models: ['anthropic/claude-opus-5.5'],
};

beforeEach(() => resetLiveCache());

test('Free uses only free models with tool calling, with fallbacks, and counts tokens', async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = network();
  const res = await chat(request(hello), env, { store, fetchImpl, now });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Lumo-Plan'), 'free');
  const text = await res.text();
  assert.match(text, /"Hi"/);
  const sent = calls.chat[0];
  assert.equal(sent.model, 'nvidia/nemotron-3.5-super-vl:free');
  assert.deepEqual(sent.models, ['nvidia/nemotron-3.5-super-vl:free', 'xingchen-agi/xing4.0-29b-a4b:free']);
  assert.equal(sent.max_tokens, 8192);
  assert.equal(sent.provider, undefined);
  assert.equal(sent.plugins, undefined);
  assert.equal(sent.user, `i:${INSTALL}`);
  assert.equal(sent.messages[1].content[1].type, 'image_url', 'the first free model can see images');
  assert.equal(store.data.get(`tok:i:${INSTALL}:2026-10`), '1200');
  assert.equal(store.data.get(`spend:i:${INSTALL}:2026-10`), undefined, 'Free has no dollar budget');

  // Asking for the text-only free model puts it first and replaces images with a note.
  await chat(request({ ...hello, model: 'xingchen-agi/xing4.0-29b-a4b:free' }), env, {
    store,
    fetchImpl,
    now,
  }).then((r) => r.text());
  assert.equal(calls.chat[1].model, 'xingchen-agi/xing4.0-29b-a4b:free');
  assert.equal(calls.chat[1].messages[1].content[1].type, 'text');
});

test('Free has a daily share and a monthly token allowance', async () => {
  const store = memoryStore();
  const { fetchImpl } = network();
  store.data.set(`rpd:i:${INSTALL}:2026-10-16`, '60');
  let res = await chat(request(hello), env, { store, fetchImpl, now });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /today's Free limit/);

  const other = 'b'.repeat(32);
  store.data.set(`tok:i:${other}:2026-10`, '1000000');
  res = await chat(request(hello, { install: other }), env, { store, fetchImpl, now });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.code, 'plan_limit');
  assert.equal(
    body.error,
    "You've used all of this month's Free usage. It resets on November 1. Upgrade to Lumo Lite or Lumo Pro in Settings → Plans for much more.",
  );
  assert.equal(body.usage.percentUsed, 100);
});

test('Lite: license checked once and cached, default model, plan model list, charge settles to the real cost', async () => {
  const store = memoryStore();
  const { fetchImpl, calls } = network();
  const res = await chat(request(hello, { license: 'mem_ABC123' }), env, { store, fetchImpl, now });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Lumo-Plan'), 'lite');
  await res.text();
  const sent = calls.chat[0];
  assert.equal(sent.model, 'anthropic/claude-haiku-5.5');
  assert.equal(sent.models, undefined);
  assert.deepEqual(
    sent.messages[0].content[0].cache_control,
    { type: 'ephemeral' },
    'Anthropic caches the prompt',
  );
  const subject = [...store.data.keys()].find((k) => k.startsWith('spend:'));
  assert.equal(store.data.get(subject), '1200', 'reported cost $0.0012 = 1200 micro-dollars');

  // A Pro model is refused on Lite, without another Whop call.
  const pro = await chat(
    request({ ...hello, model: 'anthropic/claude-sonnet-5.5' }, { license: 'mem_ABC123' }),
    env,
    {
      store,
      fetchImpl,
      now,
    },
  );
  assert.equal(pro.status, 403);
  assert.match((await pro.json()).error, /Claude Sonnet 5\.5 is part of Lumo Pro/);
  assert.equal(calls.whop, 1);
});

test('the monthly dollar budget refuses new calls once spent', async () => {
  const store = memoryStore();
  const { fetchImpl } = network({ membership: { status: 'active', plan: { id: 'plan_1ucbcMEoxhW3g' } } });
  const u0 = await usage(request(undefined, { license: 'mem_PRO999' }), env, { store, fetchImpl, now });
  assert.deepEqual(await u0.json(), {
    plan: 'pro',
    planName: 'Lumo Pro',
    percentUsed: 0,
    resetsAt: '2026-11-01T00:00:00.000Z',
  });
  const key = [...store.data.keys()].find((k) => k.startsWith('lic:'));
  assert.equal(store.data.get(key), 'pro');
  const subject = `m:${(await import('node:crypto')).createHash('sha256').update('mem_PRO999').digest('hex').slice(0, 32)}`;
  store.data.set(`spend:${subject}:2026-10`, String(18 * 1_000_000));
  const res = await chat(request(hello, { license: 'mem_PRO999' }), env, { store, fetchImpl, now });
  assert.equal(res.status, 402);
  assert.equal(
    (await res.json()).error,
    "You've used all of this month's Pro usage. It resets on November 1.",
  );
  store.data.set(`spend:${subject}:2026-10`, String(9 * 1_000_000));
  const half = await usage(request(undefined, { license: 'mem_PRO999' }), env, { store, fetchImpl, now });
  assert.equal((await half.json()).percentUsed, 50);
});

test('a busy model releases the reservation; a stopped answer keeps it', async () => {
  const store = memoryStore();
  const busy = network({ chatStatus: 429 });
  const res = await chat(request(hello, { license: 'mem_ABC123' }), env, {
    store,
    fetchImpl: busy.fetchImpl,
    now,
  });
  assert.equal(res.status, 429);
  const spendKey = () => [...store.data.keys()].find((k) => k.startsWith('spend:'));
  assert.equal(store.data.get(spendKey()), '0');

  const broke = network({ chatStatus: 402 });
  const paused = await chat(request(hello, { license: 'mem_ABC123' }), env, {
    store,
    fetchImpl: broke.fetchImpl,
    now,
  });
  assert.equal(paused.status, 503, 'out of OpenRouter credits');
  assert.match((await paused.json()).error, /paused/);
  assert.equal(store.data.get(spendKey()), '0');

  const ok = network({ usageBlock: false });
  const streaming = await chat(request(hello, { license: 'mem_ABC123' }), env, {
    store,
    fetchImpl: ok.fetchImpl,
    now,
  });
  const reader = streaming.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.ok(Number(store.data.get(spendKey())) > 4000, 'the reserved estimate stands');
});

test('who is asking, and server configuration', async () => {
  const store = memoryStore();
  const { fetchImpl } = network({ membership: { status: 'canceled', plan: { id: 'plan_0KzI2YIP7k6Pp' } } });
  assert.equal((await chat(request(hello, { install: '' }), env, { store, fetchImpl, now })).status, 400);
  assert.equal(
    (await chat(request(hello, { install: 'not-hex' }), env, { store, fetchImpl, now })).status,
    400,
  );
  const lapsed = await chat(request(hello, { license: 'mem_OLD123' }), env, { store, fetchImpl, now });
  assert.equal(lapsed.status, 403);
  assert.equal((await lapsed.json()).code, 'license_invalid');
  assert.equal((await chat(request(hello), {}, { store, fetchImpl, now })).status, 503, 'no OpenRouter key');
  assert.equal((await chat(request(hello), env, { store: null, fetchImpl, now })).status, 503, 'no Redis');
});

test('the public catalog lists Free, Lite and Pro only, with vision flags', async () => {
  const { fetchImpl } = network();
  const res = await models({}, { fetchImpl, now });
  const body = await res.json();
  assert.deepEqual(
    body.plans.map((p) => [p.id, p.priceUsd, p.defaultModel]),
    [
      ['free', 0, 'nvidia/nemotron-3.5-super-vl:free'],
      ['lite', 19.99, 'anthropic/claude-haiku-5.5'],
      ['pro', 49.99, 'anthropic/claude-sonnet-5.5'],
    ],
  );
  assert.deepEqual(
    body.plans[0].models.map((m) => [m.name, m.vision]),
    [
      ['Nemotron 3.5 Super VL', true],
      ['Xing4.0 29b A4b', false],
    ],
  );
  assert.ok(
    body.plans.slice(1).every((p) => p.models.every((m) => m.vision)),
    'paid models can see the screen',
  );
  assert.equal(body.plans[0].models[0].input, undefined, 'no internal prices');
  assert.ok(PLANS.every((p) => p.id !== 'unlimited'));
  assert.equal(nextReset(new Date('2026-12-31T23:59:00Z')), '2027-01-01T00:00:00.000Z');
});
