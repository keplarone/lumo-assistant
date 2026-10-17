// Lumo accounts: the plan follows the person, not the computer. A Whop membership (license key) is linked
// to exactly one Lumo account; signing in on any computer brings the plan with it, and Whop is asked again
// on every check so a cancelled membership stops counting.
//
// Two-step verification (an authenticator app code) and passkeys are optional. Passkeys are offered on
// AuthKit's own sign-in page. Two-step is set up here because only a server may enroll a factor, and a
// factor counts as on only after the person proves it with a code (an unconfirmed one is removed, so an
// abandoned setup can never lock anyone out). Turning it off needs a current code too.

import { AuthError, verifyAccessToken, workosApi } from './workos.js';
import { membershipKey, pendingKey, userKey } from './links.js';
import { validate } from './validate.js';

const PENDING_MS = 15 * 60 * 1000;
/** How long the model gateway trusts an account's plan before asking Whop again (see gateway.js). */
export const ACCOUNT_PLAN_TTL = 600;
export const accountPlanKey = (userId) => `acct:${userId}`;

/**
 * The plan an account has right now: its linked Whop membership's tier, or "free". Null when Whop
 * can't be asked, so callers keep what they knew rather than downgrading anyone.
 * @param {string} userId
 * @param {{ env: Record<string, string | undefined>, store: import('./links.js').LinkStore, fetch?: typeof fetch }} deps
 */
export async function accountTier(userId, deps) {
  const rec = await deps.store.read(userKey(userId));
  if (!rec?.membershipId) return 'free';
  const r = await validate(rec.membershipId, deps.env, deps.fetch ?? fetch);
  if (r.status >= 500) return null;
  return r.body.valid ? r.body.tier : 'free';
}
const CODE = /^\d{6}$/;

const ok = (body) => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });

/**
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   store: import('./links.js').LinkStore,
 *   fetch?: typeof fetch,
 *   key?: any,
 *   now?: () => number,
 *   cache?: import('./store.js').Store | null,
 * }} Deps
 */

/** Run an account action for the signed-in person. Turns expected errors into answers. */
export async function handle(action, authorization, input, deps) {
  let who;
  try {
    who = await verifyAccessToken(authorization, deps.env, deps.key);
  } catch (e) {
    return e instanceof AuthError ? fail(401, e.message) : fail(503, e.message);
  }
  const ctx = { ...deps, who, workos: workosApi(deps.env, deps.fetch ?? fetch), now: deps.now ?? Date.now };
  try {
    switch (action) {
      case 'status':
        return ok(await status(ctx));
      case 'link':
        return await link(ctx, input?.licenseKey);
      case 'unlink':
        await unlink(ctx);
        return ok(await status(ctx));
      case 'two-step-start':
        return await twoStepStart(ctx);
      case 'two-step-confirm':
        return await twoStepConfirm(ctx, input?.code);
      case 'two-step-cancel':
        await dropPending(ctx, true);
        return ok(await status(ctx));
      case 'two-step-off':
        return await twoStepOff(ctx, input?.code);
      case 'sign-out':
        if (ctx.who.sessionId) await ctx.workos.revokeSession(ctx.who.sessionId);
        return ok({ signedOut: true });
      case 'delete':
        await unlink(ctx);
        await ctx.store.remove(pendingKey(ctx.who.userId));
        await ctx.workos.deleteUser(ctx.who.userId);
        await ctx.cache?.set(accountPlanKey(ctx.who.userId), 'free', ACCOUNT_PLAN_TTL).catch(() => {});
        return ok({ deleted: true });
      default:
        return fail(404, 'Unknown account action.');
    }
  } catch (e) {
    return e instanceof AuthError ? fail(400, e.message) : fail(502, e.message || 'Something went wrong.');
  }
}

async function status(ctx) {
  const { userId } = ctx.who;
  await dropPending(ctx, false);
  const [user, factors, linkRec] = await Promise.all([
    ctx.workos.getUser(userId),
    ctx.workos.listFactors(userId),
    ctx.store.read(userKey(userId)),
  ]);
  if (!user) throw new AuthError('This Lumo account no longer exists.');
  let plan = 'free';
  let membershipStatus = null;
  let planError = null;
  if (linkRec?.membershipId) {
    const r = await validate(linkRec.membershipId, ctx.env, ctx.fetch ?? fetch);
    membershipStatus = r.body.membershipStatus ?? null;
    if (r.body.valid) plan = r.body.tier;
    else planError = r.body.error ?? null;
    // Whop being unreachable is not the person's fault: tell the app to keep what it had.
    if (r.status >= 500) return { ...base(user, factors, true), plan: null, planError, membershipStatus };
  }
  // Tell the model gateway at once, so a new or removed plan counts from the next message.
  await ctx.cache?.set(accountPlanKey(userId), plan, ACCOUNT_PLAN_TTL).catch(() => {});
  return { ...base(user, factors, !!linkRec?.membershipId), plan, planError, membershipStatus };
}

function base(user, factors, licenseLinked) {
  return {
    userId: user.id,
    email: user.email ?? null,
    emailVerified: user.email_verified === true,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
    twoStep: factors.some((f) => f.type === 'totp'),
    licenseLinked,
  };
}

async function link(ctx, licenseKey) {
  const { userId } = ctx.who;
  const r = await validate(licenseKey, ctx.env, ctx.fetch ?? fetch);
  if (!r.body.valid) return { status: r.status === 200 ? 400 : r.status, body: r.body };
  const key = membershipKey(licenseKey);
  const created = await ctx.store.write(
    key,
    { userId, linkedAt: new Date(ctx.now()).toISOString() },
    { create: true },
  );
  if (!created) {
    const owner = await ctx.store.read(key);
    if (owner?.userId !== userId)
      return fail(
        409,
        'This license is already linked to another Lumo account. Sign in with that account, or contact support.',
      );
  }
  const prev = await ctx.store.read(userKey(userId));
  if (prev?.membershipId && prev.membershipId !== licenseKey)
    await ctx.store.remove(membershipKey(prev.membershipId));
  await ctx.store.write(userKey(userId), {
    membershipId: licenseKey,
    linkedAt: new Date(ctx.now()).toISOString(),
  });
  return ok(await status(ctx));
}

async function unlink(ctx) {
  const k = userKey(ctx.who.userId);
  const rec = await ctx.store.read(k);
  if (rec?.membershipId) await ctx.store.remove(membershipKey(rec.membershipId));
  await ctx.store.remove(k);
}

/** Remove an unconfirmed two-step setup: always when asked, otherwise only once it is stale. */
async function dropPending(ctx, force) {
  const k = pendingKey(ctx.who.userId);
  const p = await ctx.store.read(k);
  if (!p) return;
  if (!force && ctx.now() - p.startedAt < PENDING_MS) return;
  if (p.factorId) await ctx.workos.deleteFactor(p.factorId);
  await ctx.store.remove(k);
}

async function twoStepStart(ctx) {
  const { userId } = ctx.who;
  await dropPending(ctx, true);
  const [user, factors] = await Promise.all([ctx.workos.getUser(userId), ctx.workos.listFactors(userId)]);
  if (!user) throw new AuthError('This Lumo account no longer exists.');
  if (factors.some((f) => f.type === 'totp')) return fail(409, 'Two-step verification is already on.');
  const r = await ctx.workos.enrollTotp(userId, user.email ?? 'Lumo account');
  const factor = r?.authentication_factor;
  const challenge = r?.authentication_challenge;
  if (!factor?.id || !challenge?.id || !factor.totp?.secret)
    throw new Error('The sign-in service could not start two-step setup.');
  await ctx.store.write(pendingKey(userId), {
    factorId: factor.id,
    challengeId: challenge.id,
    startedAt: ctx.now(),
  });
  return ok({
    qrCode: factor.totp.qr_code ?? null,
    secret: factor.totp.secret,
    uri: factor.totp.uri ?? null,
  });
}

async function twoStepConfirm(ctx, code) {
  if (typeof code !== 'string' || !CODE.test(code.trim()))
    return fail(400, 'Enter the 6-digit code from your authenticator app.');
  const k = pendingKey(ctx.who.userId);
  const p = await ctx.store.read(k);
  if (!p || ctx.now() - p.startedAt >= PENDING_MS) {
    await dropPending(ctx, true);
    return fail(410, 'That setup expired. Start again.');
  }
  // A challenge accepts only one attempt, so each wrong code gets a fresh one.
  const r = await ctx.workos.verifyChallenge(p.challengeId, code.trim());
  if (r?.valid !== true) {
    const next = await ctx.workos.challenge(p.factorId);
    if (next?.id) await ctx.store.write(k, { ...p, challengeId: next.id });
    return fail(400, 'That code didn’t match. Check the time on your phone and try the newest code.');
  }
  await ctx.store.remove(k);
  return ok(await status(ctx));
}

async function twoStepOff(ctx, code) {
  if (typeof code !== 'string' || !CODE.test(code.trim()))
    return fail(400, 'Enter a current code from your authenticator app to turn two-step verification off.');
  const totp = (await ctx.workos.listFactors(ctx.who.userId)).filter((f) => f.type === 'totp');
  if (!totp.length) return ok(await status(ctx));
  let proven = false;
  for (const f of totp) {
    const c = await ctx.workos.challenge(f.id);
    if (c?.id && (await ctx.workos.verifyChallenge(c.id, code.trim()))?.valid === true) {
      proven = true;
      break;
    }
  }
  if (!proven) return fail(400, 'That code didn’t match, so two-step verification stays on.');
  for (const f of totp) await ctx.workos.deleteFactor(f.id);
  return ok(await status(ctx));
}

/**
 * The AuthKit redirect lands here (a production redirect must be https), and is passed on to the Lumo app
 * waiting on this computer's loopback address. The port travels in the state Lumo made. The code is useless
 * without the PKCE verifier that never leaves the app, so passing it on is safe.
 */
export function callbackRedirect(url) {
  const q = new URL(url).searchParams;
  const state = q.get('state') ?? '';
  const m = /^[A-Za-z0-9_-]{22,128}\.(\d{4,5})$/.exec(state);
  const port = m ? Number(m[1]) : 0;
  if (!m || port < 1024 || port > 65535) return { status: 400, location: null };
  const out = new URLSearchParams({ state });
  const code = q.get('code');
  const error = q.get('error');
  if (code && /^[A-Za-z0-9_.-]{1,512}$/.test(code)) out.set('code', code);
  else out.set('error', error && /^[a-z_]{1,64}$/.test(error) ? error : 'access_denied');
  return { status: 302, location: `http://127.0.0.1:${port}/callback?${out}` };
}
