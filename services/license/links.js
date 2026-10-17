// Where account links live: which Whop membership belongs to which Lumo account, and two-step setups that
// are not confirmed yet. On Vercel this is a private Blob store (BLOB_READ_WRITE_TOKEN, or the project's
// OIDC token when the store is connected). Membership ids are license keys, so they are only ever stored
// in the private store and the index file names use their SHA-256, never the key itself.

import { createHash } from 'node:crypto';

export const membershipKey = (membershipId) =>
  `links/membership/${createHash('sha256').update(membershipId).digest('hex')}.json`;
export const userKey = (userId) => `links/user/${userId}.json`;
export const pendingKey = (userId) => `two-step/${userId}.json`;

/** @typedef {{ read(k: string): Promise<any>, write(k: string, v: any, opts?: { create?: boolean }): Promise<boolean>, remove(k: string): Promise<void> }} LinkStore */

/** In-memory store for tests and local runs. `create` writes only if the key is new and says if it did. */
export function memoryLinkStore() {
  const m = new Map();
  return {
    data: m,
    async read(k) {
      return m.has(k) ? structuredClone(m.get(k)) : null;
    },
    async write(k, v, opts = {}) {
      if (opts.create && m.has(k)) return false;
      m.set(k, structuredClone(v));
      return true;
    },
    async remove(k) {
      m.delete(k);
    },
  };
}

/** @returns {Promise<LinkStore>} */
export async function blobLinkStore() {
  const { get, put, del, head } = await import('@vercel/blob');
  return {
    async read(k) {
      const r = await get(k, { access: 'private', useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return JSON.parse(await new Response(r.stream).text());
    },
    async write(k, v, opts = {}) {
      try {
        await put(k, JSON.stringify(v), {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: !opts.create,
          contentType: 'application/json',
          cacheControlMaxAge: 60,
        });
        return true;
      } catch (e) {
        // A create that lost to an existing blob is an answer, not a failure.
        if (opts.create && (await head(k).catch(() => null))) return false;
        throw e;
      }
    },
    async remove(k) {
      await del(k).catch(() => {});
    },
  };
}
