// Vercel function: POST /api/validate {"licenseKey": "..."} -> {"valid": bool, "tier": "lite" | "pro" | "unlimited"}
import { validate } from '../validate.js';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ valid: false, error: 'Expected a JSON body.' }, { status: 400 });
  }
  const { status, body: out } = await validate(body?.licenseKey, process.env);
  return Response.json(out, { status, headers: { 'Cache-Control': 'no-store' } });
}
