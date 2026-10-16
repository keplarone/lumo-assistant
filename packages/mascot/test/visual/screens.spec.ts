/**
 * Screenshots of the port (with product layers) in key states, written to test-results/screens/
 * for review. Deterministic: seeded random and fixed update steps, like the parity test.
 */
import { expect, test } from '@playwright/test';
import { openRender, writeResult } from './util';

interface Shot { name: string; mood?: string; steps: number; actions?: { at: number; method: string; args?: unknown[] }[]; calm?: boolean }

const SHOTS: Shot[] = [
  { name: 'idle', mood: 'idle', steps: 90 },
  { name: 'think', mood: 'think', steps: 90 },
  { name: 'speak', mood: 'speak', steps: 90 },
  { name: 'happy', mood: 'happy', steps: 90 },
  { name: 'majestic', mood: 'majestic', steps: 90 },
  { name: 'sleep', mood: 'sleep', steps: 120 },
  { name: 'listen', mood: 'listen', steps: 90 },
  { name: 'process', mood: 'process', steps: 90 },
  { name: 'search', mood: 'search', steps: 100 },
  { name: 'work', mood: 'work', steps: 90 },
  { name: 'type', mood: 'type', steps: 130 },
  { name: 'unsure', mood: 'unsure', steps: 120 },
  { name: 'greet-wave', mood: 'greet', steps: 52 },
  { name: 'celebrate-apex', mood: 'happy', steps: 22, actions: [{ at: 0, method: 'celebrate' }] },
  { name: 'recover-droop', mood: 'recover', steps: 60 },
  { name: 'recover-shake', mood: 'recover', steps: 92 },
  { name: 'walk-anticipate', steps: 10, actions: [{ at: 0, method: 'walkTo', args: [0.9] }] },
  { name: 'walk-hop', steps: 34, actions: [{ at: 0, method: 'walkTo', args: [0.9] }] },
  { name: 'turn-mid', steps: 22, actions: [{ at: 0, method: 'turnAround' }] },
  { name: 'turned-around', steps: 90, actions: [{ at: 0, method: 'turnAround' }] },
  { name: 'look-far-right', mood: 'idle', steps: 60, actions: [{ at: 0, method: 'gaze', args: [1, 0.35] }] },
  { name: 'calm-greet', mood: 'greet', steps: 52, calm: true },
];

for (const s of SHOTS) {
  test(`screen: ${s.name}`, async ({ page }) => {
    await openRender(page, 'companion', s.calm ? '&calm' : '');
    const r = await page.evaluate((s) => (window as unknown as { __lumo: { run(o: object): { calls: number; state: string } } }).__lumo.run(s), { mood: s.mood, steps: s.steps, actions: s.actions });
    expect(r.calls).toBeGreaterThan(0);
    const png = await page.locator('#stage').screenshot({ animations: 'disabled' });
    writeResult(`screens/${s.name}.png`, png);
  });
}
