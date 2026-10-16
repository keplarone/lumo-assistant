import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../validate.js';

const env = { WHOP_API_KEY: 'k', WHOP_PLANS_LITE: 'plan_lite', WHOP_PLANS_PRO: 'plan_pro1, plan_pro2' };
const fake = (status, json) => async (url, init) => {
  assert.match(url, /^https:\/\/api\.whop\.com\/api\/v1\/memberships\//);
  assert.equal(init.headers.Authorization, 'Bearer k');
  return { status, ok: status < 300, json: async () => json };
};

test('active Pro and Lite memberships map to tiers', async () => {
  let r = await validate('A1B2C3-D4E5F6', env, fake(200, { status: 'active', plan: { id: 'plan_pro2' } }));
  assert.deepEqual(r.body, { valid: true, tier: 'pro', membershipStatus: 'active' });
  r = await validate('A1B2C3-D4E5F6', env, fake(200, { status: 'trialing', plan: { id: 'plan_lite' } }));
  assert.equal(r.body.tier, 'lite');
});

test('inactive, unknown and foreign memberships are rejected', async () => {
  assert.equal((await validate('A1B2C3-D4E5F6', env, fake(200, { status: 'expired', plan: { id: 'plan_pro1' } }))).body.valid, false);
  assert.equal((await validate('A1B2C3-D4E5F6', env, fake(200, { status: 'active', plan: { id: 'plan_other' } }))).body.valid, false);
  assert.equal((await validate('A1B2C3-D4E5F6', env, fake(404, {}))).body.valid, false);
});

test('bad input and missing configuration', async () => {
  assert.equal((await validate('../etc', env, fake(200, {}))).status, 400);
  assert.equal((await validate('A1B2C3-D4E5F6', {}, fake(200, {}))).status, 503);
});

test('defaults to the Lumo plan ids', async () => {
  const r = await validate('A1B2C3-D4E5F6', { WHOP_API_KEY: 'k' }, fake(200, { status: 'active', plan: { id: 'plan_0KzI2YIP7k6Pp' } }));
  assert.equal(r.body.tier, 'lite');
});
