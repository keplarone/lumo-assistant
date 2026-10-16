export const SITE = {
  name: 'Lumo',
  fullName: 'Lumo Assistant',
  /** Production origin (astro.config.mjs uses the same default). */
  url: 'https://lumo.keplar.one',
  tagline: 'Tell Lumo what you want. Lumo figures out how to make it happen.',
  description:
    'Download Lumo, the desktop AI assistant for Windows, macOS and Linux. Tell Lumo what you want: it plans the steps, uses real tools with your permission and reports back.',
  repo: 'https://github.com/keplarone/lumo-assistant',
  issues: 'https://github.com/keplarone/lumo-assistant/issues',
} as const;

export interface NavItem {
  href: string;
  label: string;
}

/** Footer links: the legal pages (the only pages besides the download page) and the source. */
export const FOOTER_NAV: NavItem[] = [
  { href: '/privacy/', label: 'Privacy' },
  { href: '/terms/', label: 'Terms' },
  { href: '/licenses/', label: 'Licenses' },
  { href: SITE.repo, label: 'GitHub' },
  { href: SITE.issues, label: 'Report an issue' },
];
