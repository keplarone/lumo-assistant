import type { ThemeSetting } from './ipc';

export type ResolvedTheme = 'dark' | 'light';

/** "system" follows the OS; the tokens have one definition per theme, selected by data-theme. */
export function resolveTheme(
  setting: ThemeSetting | string | undefined,
  prefersDark: boolean,
): ResolvedTheme {
  if (setting === 'dark' || setting === 'light') return setting;
  return prefersDark ? 'dark' : 'light';
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
}

/** Apply the theme to <html>, and keep following the OS while the setting is "system". Returns a cleanup. */
export function applyTheme(
  setting: ThemeSetting | string | undefined,
  root: HTMLElement = document.documentElement,
): () => void {
  const set = () => root.setAttribute('data-theme', resolveTheme(setting, systemPrefersDark()));
  set();
  if (setting !== 'system' || typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', set);
  return () => mq.removeEventListener('change', set);
}
