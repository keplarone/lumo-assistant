// Vercel function: GET /api/auth/callback — AuthKit's sign-in redirect, passed on to the Lumo app on this
// computer. See callbackRedirect in accounts.js.
import { callbackRedirect } from '../../accounts.js';

export function GET(request) {
  const { status, location } = callbackRedirect(request.url);
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (!location)
    return new Response('This sign-in link is not valid. Go back to Lumo and try again.', {
      status,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  return new Response(null, { status, headers: { ...headers, Location: location } });
}
