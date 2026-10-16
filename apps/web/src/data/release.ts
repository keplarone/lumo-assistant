/**
 * The one place the download page reads release data from.
 *
 * To publish a build: set `version` (e.g. '0.1.0') once the GitHub release `v<version>` exists with
 * the assets named below. While `version` is null there is nothing to download, and the page shows a
 * disabled "Coming soon" state that links to the releases page instead of inventing file links.
 */
export const RELEASE = {
  version: null as string | null,
  repo: 'keplarone/lumo-assistant',
};

export type PlatformId = 'windows' | 'macos' | 'linux';

export interface Asset {
  /** Shown on the link, e.g. "Installer". */
  label: string;
  /** File type, e.g. ".exe". */
  format: string;
  file: string;
  url: string;
}

export interface Platform {
  id: PlatformId;
  name: string;
  /** Provisional minimums (Tauri 2), confirmed with the first release. */
  requirements: string[];
}

export const PLATFORMS: readonly Platform[] = [
  {
    id: 'windows',
    name: 'Windows',
    requirements: ['Windows 10 or 11, 64-bit', 'Microsoft WebView2 runtime (included with Windows 11)'],
  },
  {
    id: 'macos',
    name: 'macOS',
    requirements: ['macOS 10.15 Catalina or later', 'Apple silicon or Intel (one universal build)'],
  },
  {
    id: 'linux',
    name: 'Linux',
    requirements: ['64-bit x86 (amd64)', 'WebKitGTK 4.1, for example Ubuntu 22.04, Debian 12 or newer'],
  },
];

export function releasesUrl(repo = RELEASE.repo): string {
  return `https://github.com/${repo}/releases`;
}

/** Download assets for one platform, primary first. Empty when no version is published. */
export function assetsFor(id: PlatformId, version: string | null = RELEASE.version, repo = RELEASE.repo): Asset[] {
  if (!version) return [];
  const base = `${releasesUrl(repo)}/download/v${version}/`;
  const make = (label: string, format: string, file: string): Asset => ({ label, format, file, url: base + file });
  switch (id) {
    case 'macos':
      return [make('Universal disk image', '.dmg', `Lumo_${version}_universal.dmg`)];
    case 'windows':
      return [make('Installer', '.exe', `Lumo_${version}_x64-setup.exe`)];
    case 'linux':
      return [make('AppImage', '.AppImage', `Lumo_${version}_amd64.AppImage`), make('Debian package', '.deb', `Lumo_${version}_amd64.deb`)];
  }
}
