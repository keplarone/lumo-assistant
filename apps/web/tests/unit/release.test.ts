/** Unit tests for the release data and OS detection. node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, RELEASE, assetsFor, releasesUrl } from '../../src/data/release.ts';
import { detectOS } from '../../src/lib/os.ts';

test('no version means no download assets for any platform', () => {
  for (const p of PLATFORMS) assert.deepEqual(assetsFor(p.id, null), []);
});

test('the release data is a version (or null) and the repo', () => {
  assert.equal(RELEASE.repo, 'keplarone/lumo-assistant');
  assert.ok(RELEASE.version === null || /^\d+\.\d+\.\d+/.test(RELEASE.version));
  assert.equal(releasesUrl(), 'https://github.com/keplarone/lumo-assistant/releases');
});

test('asset URLs follow the GitHub release naming', () => {
  const base = 'https://github.com/keplarone/lumo-assistant/releases/download/v0.1.0/';
  assert.deepEqual(
    assetsFor('macos', '0.1.0').map((a) => a.url),
    [`${base}Lumo_0.1.0_universal.dmg`],
  );
  assert.deepEqual(
    assetsFor('windows', '0.1.0').map((a) => a.url),
    [`${base}Lumo_0.1.0_x64-setup.exe`],
  );
  assert.deepEqual(
    assetsFor('linux', '0.1.0').map((a) => a.url),
    [`${base}Lumo_0.1.0_amd64.AppImage`, `${base}Lumo_0.1.0_amd64.deb`],
  );
});

test('detects desktop platforms from the user agent and platform', () => {
  assert.equal(detectOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140', 'Win32'), 'windows');
  assert.equal(detectOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 'MacIntel'), 'macos');
  assert.equal(detectOS('Mozilla/5.0 (X11; Linux x86_64) Firefox/140', 'Linux x86_64'), 'linux');
  assert.equal(detectOS('', 'macOS'), 'macos');
});

test('phones, tablets and unknown systems are not guessed', () => {
  assert.equal(
    detectOS('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537', 'Linux armv8l'),
    'other',
  );
  assert.equal(
    detectOS('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', 'iPhone'),
    'other',
  );
  // iPadOS presents itself as a Mac, but has a touch screen.
  assert.equal(
    detectOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 'MacIntel', 5),
    'other',
  );
  assert.equal(detectOS('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140', 'Linux x86_64'), 'other');
  assert.equal(detectOS('', ''), 'other');
});
