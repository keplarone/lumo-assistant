/** Unit tests for the analytics snippet: runs it against fake browser globals. node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_SNIPPET } from '../../src/lib/analytics.ts';

function run({ endpoint = 'https://stats.example/hit', dnt, gpc, referrer = '' }: { endpoint?: string | null; dnt?: string; gpc?: boolean; referrer?: string }) {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const win = {
    location: { pathname: '/features/', hostname: 'lumo.test' },
    innerWidth: 1280,
    doNotTrack: undefined as string | undefined,
    fetch: (url: string, init: Record<string, unknown>) => calls.push({ url, init }),
  };
  const doc = { referrer, currentScript: { getAttribute: () => endpoint } };
  const nav = { doNotTrack: dnt, globalPrivacyControl: gpc };
  const fn = new Function('document', 'window', 'navigator', 'URL', ANALYTICS_SNIPPET);
  fn(doc, win, nav, URL);
  return calls;
}

test('sends one cookieless page view with path, referrer host and size class', () => {
  const calls = run({ referrer: 'https://news.example/item?id=1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://stats.example/hit');
  assert.equal(calls[0]!.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { p: '/features/', r: 'news.example', v: 'l' });
});

test('does nothing without an endpoint', () => {
  assert.equal(run({ endpoint: null }).length, 0);
});

test('respects Do Not Track', () => {
  assert.equal(run({ dnt: '1' }).length, 0);
});

test('respects Global Privacy Control', () => {
  assert.equal(run({ gpc: true }).length, 0);
});
