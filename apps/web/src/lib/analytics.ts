/**
 * First-party, cookieless page-view counting.
 *
 * - Off by default. It is only included in the page when PUBLIC_ANALYTICS_ENDPOINT is set at build
 *   time; otherwise no script is emitted at all.
 * - Never sends when Do Not Track or Global Privacy Control is on.
 * - Sends one request per page view with: the path, the referring site's host name (not the full
 *   URL), and a coarse viewport class (small, medium or large). No cookies, no local storage, no
 *   identifiers, no fingerprinting, `credentials: 'omit'`.
 *
 * The snippet is plain ES2017 kept as a string so it can be inlined without a bundle request and
 * tested directly (tests/unit/analytics.test.ts). It is a classic script that reads its endpoint
 * from its own data attribute.
 */

export const ANALYTICS_ENDPOINT: string = (import.meta.env?.PUBLIC_ANALYTICS_ENDPOINT as string | undefined) ?? '';

export const ANALYTICS_SNIPPET = `(function (s, w, d, n) {
  var e = s && s.getAttribute('data-endpoint');
  if (!e) return;
  if (n.globalPrivacyControl === true || n.doNotTrack === '1' || n.doNotTrack === 'yes' || w.doNotTrack === '1') return;
  var r = '';
  try { r = d.referrer ? new URL(d.referrer).hostname : ''; } catch (_) {}
  if (r === w.location.hostname) r = '';
  var vw = w.innerWidth || 0;
  var body = JSON.stringify({ p: w.location.pathname, r: r, v: vw < 640 ? 's' : vw < 1100 ? 'm' : 'l' });
  try { w.fetch(e, { method: 'POST', body: body, keepalive: true, credentials: 'omit', mode: 'no-cors', headers: { 'content-type': 'text/plain' } }); } catch (_) {}
})(document.currentScript, window, document, navigator);`;
