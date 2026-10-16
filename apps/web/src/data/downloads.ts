/**
 * Per-platform download data. The release process updates this file: set `released` to true and fill
 * `version`, `url`, `size` and `sha256` for each build once a signed release is published.
 * While `released` is false, every build links to the releases page and is labelled
 * "Preview, not yet released".
 */

export const RELEASES_URL = 'https://github.com/keplarone/lumo-assistant/releases';

export interface Build {
  /** e.g. "Windows installer" */
  label: string;
  /** File type shown to the user, e.g. ".msi" */
  format: string;
  /** Who this build is for. */
  detail: string;
  /** Direct link once released. Falls back to RELEASES_URL. */
  url?: string;
  size?: string;
  sha256?: string;
}

export interface Platform {
  id: 'windows' | 'macos' | 'linux';
  name: string;
  requirements: string;
  builds: Build[];
}

export const release = {
  released: false,
  version: null as string | null,
  /** Shown while nothing is released. */
  statusLabel: 'Preview, not yet released',
  /** Requirements follow the Tauri 2 platform minimums and are confirmed with the first release. */
  requirementsNote: 'System requirements are provisional and will be confirmed with the first release.',
};

export const PLATFORMS: readonly Platform[] = [
  {
    id: 'windows',
    name: 'Windows',
    requirements: 'Windows 10 or 11, 64-bit, with the Microsoft WebView2 runtime (included in Windows 11).',
    builds: [
      { label: 'Windows installer', format: '.msi', detail: 'Windows Installer package, suited to managed installs.' },
      { label: 'Windows setup', format: '.exe', detail: 'Setup program for a standard install.' },
    ],
  },
  {
    id: 'macos',
    name: 'macOS',
    requirements: 'macOS 10.15 Catalina or later.',
    builds: [
      { label: 'Apple Silicon', format: '.dmg', detail: 'For Macs with M-series chips.' },
      { label: 'Intel', format: '.dmg', detail: 'For Macs with Intel processors.' },
    ],
  },
  {
    id: 'linux',
    name: 'Linux',
    requirements: '64-bit x86 with WebKitGTK 4.1 (for example Ubuntu 22.04, Debian 12 or newer).',
    builds: [
      { label: 'AppImage', format: '.AppImage', detail: 'Runs on most distributions without installing.' },
      { label: 'Debian package', format: '.deb', detail: 'For Debian, Ubuntu and derivatives.' },
    ],
  },
];

export function buildHref(b: Build): string {
  return release.released && b.url ? b.url : RELEASES_URL;
}
