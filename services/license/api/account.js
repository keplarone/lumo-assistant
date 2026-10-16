// Vercel function: POST /api/account {"action": "...", ...} with "Authorization: Bearer <AuthKit access token>".
// Actions: status, link {licenseKey}, unlink, two-step-start, two-step-confirm {code}, two-step-cancel,
// two-step-off {code}, sign-out, delete. See accounts.js.
import { handle } from '../accounts.js';
import { blobStore } from '../store.js';

let store = null;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }
  store ??= await blobStore();
  const { status, body: out } = await handle(
    typeof body?.action === 'string' ? body.action : '',
    request.headers.get('authorization'),
    body,
    { env: process.env, store },
  );
  return Response.json(out, { status, headers: { 'Cache-Control': 'no-store' } });
}
