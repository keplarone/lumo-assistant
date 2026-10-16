import type { PlatformId } from '../data/release';

/**
 * Picks the desktop platform to offer first. Phones, tablets and anything unrecognised return
 * 'other', so the page shows every platform equally instead of guessing.
 */
export function detectOS(userAgent: string, platform = '', maxTouchPoints = 0): PlatformId | 'other' {
  const s = `${platform} ${userAgent}`.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile|cros/.test(s)) return 'other';
  if (/windows|win32|win64/.test(s)) return 'windows';
  // iPadOS reports a Mac user agent; a touch screen gives it away.
  if (/mac/.test(s)) return maxTouchPoints > 1 ? 'other' : 'macos';
  if (/linux|x11/.test(s)) return 'linux';
  return 'other';
}
