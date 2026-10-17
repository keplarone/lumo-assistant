import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { callbackRedirect, handle } from '../accounts.js';
import { memoryLinkStore as memoryStore, membershipKey, pendingKey, userKey } from '../links.js';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
const key = createLocalJWKSet({ keys: [jwk] });
const other = await generateKeyPair('RS256');

const token = async (sub, opts = {}) =>
  'Bearer ' +
  (await new SignJWT({ sid: 'session_1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey));

const env = {
  WORKOS_API_KEY: 'sk_test',
  WORKOS_CLIENT_ID: 'client_1',
  WHOP_API_KEY: 'whop',
  WHOP_PLANS_PRO: 'plan_pro',
};

/** A fake WorkOS + Whop. */
function world() {
  const users = {
    user_A: { id: 'user_A', email: 'a@example.com', email_verified: true, first_name: 'Ada' },
    user_B: { id: 'user_B', email: 'b@example.com' },
  };
  const memberships = {
    mem_PRO_000001: { status: 'active', plan: { id: 'plan_pro' } },
    mem_OLD_000001: { status: 'expired', plan: { id: 'plan_pro' } },
  };
  const factors = [];
  const challenges = {};
  const calls = [];
  let n = 0;
  let whopDown = false;
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.hostname === 'api.whop.com') {
      if (whopDown) return json(500, {});
      const m = memberships[decodeURIComponent(u.pathname.split('/').pop())];
      return m ? json(200, m) : json(404, {});
    }
    assert.equal(init.headers.Authorization, 'Bearer sk_test');
    const p = u.pathname.split('/').filter(Boolean);
    const body = init.body ? JSON.parse(init.body) : {};
    if (p[0] === 'user_management' && p[1] === 'users') {
      const user = users[p[2]];
      if (!user) return json(404, {});
      if (p[3] === 'auth_factors' && method === 'GET')
        return json(200, { data: factors.filter((f) => f.user === p[2]) });
      if (p[3] === 'auth_factors' && method === 'POST') {
        const f = {
          id: `auth_factor_${++n}`,
          type: 'totp',
          user: p[2],
          totp: { secret: 'SECRET', qr_code: 'data:image/png;base64,AA', uri: 'otpauth://x' },
        };
        factors.push(f);
        const c = { id: `auth_challenge_${++n}`, factor: f.id };
        challenges[c.id] = c;
        return json(201, { authentication_factor: f, authentication_challenge: c });
      }
      if (method === 'DELETE') {
        delete users[p[2]];
        return json(204, null);
      }
      return json(200, user);
    }
    if (p[0] === 'auth' && p[1] === 'factors' && p[3] === 'challenge') {
      const c = { id: `auth_challenge_${++n}`, factor: p[2] };
      challenges[c.id] = c;
      return json(201, c);
    }
    if (p[0] === 'auth' && p[1] === 'factors' && method === 'DELETE') {
      const i = factors.findIndex((f) => f.id === p[2]);
      if (i >= 0) factors.splice(i, 1);
      return json(204, null);
    }
    if (p[0] === 'auth' && p[1] === 'challenges') {
      const c = challenges[p[2]];
      if (!c || c.used) return json(404, {});
      c.used = true;
      return json(200, { valid: body.code === '123456', challenge: c });
    }
    if (u.pathname === '/user_management/sessions/revoke') return json(200, {});
    return json(404, {});
  };
  return { users, memberships, factors, calls, fetch: fetchImpl, setWhopDown: (v) => (whopDown = v) };
}

const deps = (w, store, now) => ({ env, store, fetch: w.fetch, key, now });

test('rejects missing, forged and expired tokens', async () => {
  const w = world();
  const store = memoryStore();
  assert.equal((await handle('status', null, {}, deps(w, store))).status, 401);
  assert.equal((await handle('status', 'Bearer nope', {}, deps(w, store))).status, 401);
  assert.equal(
    (await handle('status', await token('user_A', { key: other.privateKey }), {}, deps(w, store))).status,
    401,
  );
  assert.equal(
    (
      await handle(
        'status',
        await token('user_A', { exp: Math.floor(Date.now() / 1000) - 120 }),
        {},
        deps(w, store),
      )
    ).status,
    401,
  );
  assert.equal((await handle('status', await token('org_A'), {}, deps(w, store))).status, 401);
  assert.equal(w.calls.length, 0, 'nothing is looked up for a bad token');
});

test('status of a new account is free with two-step off', async () => {
  const w = world();
  const r = await handle('status', await token('user_A'), {}, deps(w, memoryStore()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    userId: 'user_A',
    email: 'a@example.com',
    emailVerified: true,
    name: 'Ada',
    twoStep: false,
    licenseLinked: false,
    plan: 'free',
    planError: null,
    membershipStatus: null,
  });
});

test('a license links to one account and follows it', async () => {
  const w = world();
  const store = memoryStore();
  const a = await token('user_A');
  const b = await token('user_B');
  let r = await handle('link', a, { licenseKey: 'mem_NOPE_00001' }, deps(w, store));
  assert.equal(r.status, 400);
  r = await handle('link', a, { licenseKey: 'mem_OLD_000001' }, deps(w, store));
  assert.equal(r.status, 400, 'an expired membership is not linked');
  r = await handle('link', a, { licenseKey: 'mem_PRO_000001' }, deps(w, store));
  assert.equal(r.status, 200);
  assert.equal(r.body.plan, 'pro');
  assert.equal(r.body.licenseLinked, true);
  assert.ok(
    ![...store.data.keys()].some((k) => k.includes('mem_PRO')),
    'license keys never appear in file names',
  );

  // Linking again is fine; a second account can't take it.
  assert.equal((await handle('link', a, { licenseKey: 'mem_PRO_000001' }, deps(w, store))).status, 200);
  r = await handle('link', b, { licenseKey: 'mem_PRO_000001' }, deps(w, store));
  assert.equal(r.status, 409);

  // Cancelled on Whop: the account drops to free but stays linked for when it renews.
  w.memberships.mem_PRO_000001.status = 'expired';
  r = await handle('status', a, {}, deps(w, store));
  assert.equal(r.body.plan, 'free');
  assert.equal(r.body.licenseLinked, true);
  // Whop down: the server says it doesn't know, rather than downgrading.
  w.memberships.mem_PRO_000001.status = 'active';
  w.setWhopDown(true);
  r = await handle('status', a, {}, deps(w, store));
  assert.equal(r.body.plan, null);
  w.setWhopDown(false);

  r = await handle('unlink', a, {}, deps(w, store));
  assert.equal(r.body.plan, 'free');
  assert.equal(store.data.size, 0);
  assert.equal((await handle('link', b, { licenseKey: 'mem_PRO_000001' }, deps(w, store))).body.plan, 'pro');
});

test('two-step setup must be confirmed and needs a code to turn off', async () => {
  const w = world();
  const store = memoryStore();
  const a = await token('user_A');
  let r = await handle('two-step-start', a, {}, deps(w, store));
  assert.equal(r.status, 200);
  assert.equal(r.body.secret, 'SECRET');
  assert.ok(store.data.has(pendingKey('user_A')));

  r = await handle('two-step-confirm', a, { code: 'abc' }, deps(w, store));
  assert.equal(r.status, 400);
  r = await handle('two-step-confirm', a, { code: '000000' }, deps(w, store));
  assert.equal(r.status, 400);
  r = await handle('two-step-confirm', a, { code: '123456' }, deps(w, store));
  assert.equal(r.status, 200, 'a wrong code gets a fresh challenge, so the right one still works');
  assert.equal(r.body.twoStep, true);
  assert.ok(!store.data.has(pendingKey('user_A')));
  assert.equal((await handle('two-step-start', a, {}, deps(w, store))).status, 409);

  r = await handle('two-step-off', a, {}, deps(w, store));
  assert.equal(r.status, 400);
  r = await handle('two-step-off', a, { code: '999999' }, deps(w, store));
  assert.equal(r.status, 400);
  assert.equal(w.factors.length, 1);
  r = await handle('two-step-off', a, { code: '123456' }, deps(w, store));
  assert.equal(r.body.twoStep, false);
  assert.equal(w.factors.length, 0);
});

test('an abandoned two-step setup is removed so it cannot lock anyone out', async () => {
  const w = world();
  const store = memoryStore();
  const a = await token('user_A');
  let t = 1_000_000;
  const now = () => t;
  await handle('two-step-start', a, {}, deps(w, store, now));
  assert.equal(w.factors.length, 1);
  t += 16 * 60 * 1000;
  const r = await handle('status', a, {}, deps(w, store, now));
  assert.equal(r.body.twoStep, false);
  assert.equal(w.factors.length, 0);
  assert.equal((await handle('two-step-confirm', a, { code: '123456' }, deps(w, store, now))).status, 410);

  await handle('two-step-start', a, {}, deps(w, store, now));
  await handle('two-step-cancel', a, {}, deps(w, store, now));
  assert.equal(w.factors.length, 0);
});

test('sign out revokes the session and delete removes the account and its link', async () => {
  const w = world();
  const store = memoryStore();
  const a = await token('user_A');
  await handle('link', a, { licenseKey: 'mem_PRO_000001' }, deps(w, store));
  assert.equal((await handle('sign-out', a, {}, deps(w, store))).status, 200);
  assert.ok(w.calls.includes('POST /user_management/sessions/revoke'));
  assert.equal((await handle('delete', a, {}, deps(w, store))).status, 200);
  assert.equal(w.users.user_A, undefined);
  assert.ok(!store.data.has(userKey('user_A')));
  assert.ok(!store.data.has(membershipKey('mem_PRO_000001')));
  assert.equal((await handle('status', a, {}, deps(w, store))).status, 400);
  assert.equal((await handle('nope', a, {}, deps(w, store))).status, 404);
});

test('the sign-in redirect only ever goes to this computer', () => {
  const s = 'A'.repeat(32);
  let r = callbackRedirect(`https://x/api/auth/callback?code=01ABC&state=${s}.51234`);
  assert.equal(r.location, `http://127.0.0.1:51234/callback?state=${s}.51234&code=01ABC`);
  r = callbackRedirect(`https://x/api/auth/callback?error=access_denied&state=${s}.51234`);
  assert.match(r.location, /error=access_denied/);
  r = callbackRedirect(`https://x/api/auth/callback?code=<script>&state=${s}.51234`);
  assert.match(r.location, /error=access_denied/);
  for (const bad of [`${s}.80`, `${s}.70000`, `short.51234`, `${s}.51234@evil.com`, `${s}`, ''])
    assert.equal(
      callbackRedirect(`https://x/api/auth/callback?code=1&state=${encodeURIComponent(bad)}`).status,
      400,
      bad,
    );
});
