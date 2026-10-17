export const SITE = {
  name: 'Lumo',
  fullName: 'Lumo Assistant',
  /** Production origin (astro.config.mjs uses the same default). */
  url: 'https://lumo.keplar.one',
  tagline: 'Your personal AI assistant.',
  /** One line under the tagline: the two modes. */
  modes: 'Lumo helps with everyday and personal things. Switch to Linx Code for work and business.',
  description:
    'Download Lumo, your personal AI assistant for Windows, macOS and Linux. Chat with Lumo for everyday and personal things, or switch to Linx Code for work and business.',
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
