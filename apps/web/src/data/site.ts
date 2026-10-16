export const SITE = {
  name: 'Lumo',
  fullName: 'Lumo Assistant',
  tagline: 'Tell Lumo what you want. Lumo figures out how to make it happen.',
  description:
    'Lumo is a desktop AI assistant that understands what you want, plans the steps, uses real tools with your permission and reports back. Free, local-first, bring your own model key.',
  repo: 'https://github.com/keplarone/lumo-assistant',
  issues: 'https://github.com/keplarone/lumo-assistant/issues',
  releases: 'https://github.com/keplarone/lumo-assistant/releases',
} as const;

export interface NavItem {
  href: string;
  label: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: '/features/', label: 'Features' },
  { href: '/how-it-works/', label: 'How it works' },
  { href: '/integrations/', label: 'Integrations' },
  { href: '/security/', label: 'Security' },
  { href: '/pricing/', label: 'Pricing' },
  { href: '/docs/', label: 'Docs' },
];

export const FOOTER_NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Product',
    items: [
      { href: '/features/', label: 'Features' },
      { href: '/how-it-works/', label: 'How Lumo works' },
      { href: '/integrations/', label: 'Integrations' },
      { href: '/pricing/', label: 'Pricing' },
      { href: '/download/', label: 'Download' },
    ],
  },
  {
    title: 'Help',
    items: [
      { href: '/docs/', label: 'Getting started' },
      { href: '/support/', label: 'Support' },
      { href: '/security/', label: 'Security & privacy' },
    ],
  },
  {
    title: 'Legal',
    items: [
      { href: '/legal/terms/', label: 'Terms' },
      { href: '/legal/privacy/', label: 'Privacy policy' },
      { href: '/legal/licenses/', label: 'Open-source licenses' },
    ],
  },
];
