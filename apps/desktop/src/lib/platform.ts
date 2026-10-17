/**
 * What this device can do. The same UI is meant to run in a future phone app, so features that only
 * exist on a computer (Lumo flying over the desktop, the animated tray/taskbar/Dock icon, the global
 * shortcut) check here instead of assuming a desktop.
 */
function detectPhone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS reports a Mac user agent; a Mac never has several touch points.
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

const phone = detectPhone();

export const capabilities = {
  /** Lumo's own always-on-top window that flies around the screen. */
  desktopBuddy: !phone,
  /** The tray, taskbar and Dock icon that animate while Lumo runs. */
  liveIcon: !phone,
  /** A keyboard shortcut that opens Lumo from any app. */
  globalShortcut: !phone,
} as const;
