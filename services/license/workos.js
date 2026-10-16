// WorkOS AuthKit for Lumo accounts. The desktop app signs people in on AuthKit's hosted page (Google,
// email + password, passkeys, two-step codes) with PKCE, so it holds no WorkOS secret. This server checks
// the access tokens the app sends and uses the WorkOS API key for the few things only a server may do.
// Configuration (environment variables):
//   WORKOS_CLIENT_ID   the AuthKit client id (public; access tokens are signed with this client's keys)
//   WORKOS_API_KEY     WorkOS secret key, server only (two-step setup, sign-out, account deletion)
//   WORKOS_API_BASE    optional, defaults to https://api.workos.com

import { createRemoteJWKSet, jwtVerify } from 'jose';

const ID = /^[A-Za-z0-9_]{4,64}$/;
let jwks = null;
let jwksFor = null;

export const apiBase = (env) => (env.WORKOS_API_BASE || 'https://api.workos.com').replace(/\/$/, '');

export class AuthError extends Error {}

/**
 * Check an AuthKit access token and return who it belongs to.
 * @param {string | null | undefined} header the Authorization header
 * @param {Record<string, string | undefined>} env
 * @param {Parameters<typeof jwtVerify>[1]} [key] signing keys (tests pass a local set)
 */
export async function verifyAccessToken(header, env, key) {
  const m = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(header ?? '');
  if (!m) throw new AuthError('Sign in to Lumo first.');
  if (!key) {
    if (!env.WORKOS_CLIENT_ID) throw new Error('Accounts are not configured on the server.');
    if (jwksFor !== env.WORKOS_CLIENT_ID) {
      jwks = createRemoteJWKSet(
        new URL(`${apiBase(env)}/sso/jwks/${encodeURIComponent(env.WORKOS_CLIENT_ID)}`),
      );
      jwksFor = env.WORKOS_CLIENT_ID;
    }
    key = jwks;
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(m[1], key, { algorithms: ['RS256'], clockTolerance: 30 }));
  } catch {
    throw new AuthError('Your sign-in has expired. Sign in again.');
  }
  if (typeof payload.sub !== 'string' || !payload.sub.startsWith('user_') || !ID.test(payload.sub))
    throw new AuthError('That sign-in is not for a Lumo account.');
  if (typeof payload.exp !== 'number') throw new AuthError('That sign-in has no expiry.');
  return { userId: payload.sub, sessionId: typeof payload.sid === 'string' ? payload.sid : null };
}

/** A small WorkOS API client. Every id that goes into a URL is checked first. */
export function workosApi(env, fetchImpl = fetch) {
  const call = async (method, path, body) => {
    if (!env.WORKOS_API_KEY) throw new Error('Accounts are not configured on the server.');
    let res;
    try {
      res = await fetchImpl(`${apiBase(env)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.WORKOS_API_KEY}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Could not reach the sign-in service.');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`The sign-in service answered with HTTP ${res.status}.`);
    if (res.status === 204) return {};
    try {
      return await res.json();
    } catch {
      return {};
    }
  };
  const id = (v) => {
    if (typeof v !== 'string' || !ID.test(v)) throw new AuthError('Unknown id.');
    return encodeURIComponent(v);
  };
  return {
    getUser: (userId) => call('GET', `/user_management/users/${id(userId)}`),
    deleteUser: (userId) => call('DELETE', `/user_management/users/${id(userId)}`),
    listFactors: async (userId) =>
      (await call('GET', `/user_management/users/${id(userId)}/auth_factors`))?.data ?? [],
    enrollTotp: (userId, email) =>
      call('POST', `/user_management/users/${id(userId)}/auth_factors`, {
        type: 'totp',
        totp_issuer: 'Lumo',
        totp_user: email,
      }),
    challenge: (factorId) => call('POST', `/auth/factors/${id(factorId)}/challenge`, {}),
    verifyChallenge: (challengeId, code) =>
      call('POST', `/auth/challenges/${id(challengeId)}/verify`, { code }),
    deleteFactor: (factorId) => call('DELETE', `/auth/factors/${id(factorId)}`),
    revokeSession: (sessionId) => call('POST', '/user_management/sessions/revoke', { session_id: sessionId }),
  };
}
