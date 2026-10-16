// Vercel function: GET /api/usage -> {"plan", "planName", "percentUsed", "resetsAt"} for the caller (see gateway.js).
import { usage } from '../gateway.js';
import { blobLinkStore } from '../links.js';
import { redisStore } from '../store.js';

export async function GET(request) {
  return usage(request, process.env, {
    store: redisStore(process.env),
    links: await blobLinkStore(),
  });
}
