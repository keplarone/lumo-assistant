/**
 * Major open-source components used by the Lumo app and this website, with their licenses.
 * Versions and licenses were read from each package's package.json. Update when dependencies change.
 */
export interface LicenseEntry {
  name: string;
  license: string;
  url: string;
  use: string;
  copyright?: string;
}

export const FONTS: LicenseEntry[] = [
  {
    name: 'Inter',
    license: 'SIL Open Font License 1.1',
    url: 'https://github.com/rsms/inter',
    use: 'Interface and body text',
    copyright: 'Copyright 2020 The Inter Project Authors',
  },
  {
    name: 'Bricolage Grotesque',
    license: 'SIL Open Font License 1.1',
    url: 'https://github.com/ateliertriay/bricolage',
    use: 'Display headings',
    copyright: 'Copyright 2022 The Bricolage Grotesque Project Authors',
  },
  {
    name: 'IBM Plex Mono',
    license: 'SIL Open Font License 1.1',
    url: 'https://github.com/IBM/plex',
    use: 'Code and labels',
    copyright: 'Copyright © 2017 IBM Corp., with Reserved Font Name “Plex”',
  },
];

export const PACKAGES: LicenseEntry[] = [
  { name: 'Tauri', license: 'MIT or Apache-2.0', url: 'https://tauri.app', use: 'Desktop app shell' },
  { name: 'React and React DOM', license: 'MIT', url: 'https://react.dev', use: 'Interface' },
  { name: 'three.js', license: 'MIT', url: 'https://threejs.org', use: 'The Lumo mascot and 3D scenes' },
  {
    name: 'React Three Fiber',
    license: 'MIT',
    url: 'https://github.com/pmndrs/react-three-fiber',
    use: '3D rendering in React',
  },
  {
    name: 'Radix UI Primitives',
    license: 'MIT',
    url: 'https://www.radix-ui.com/primitives',
    use: 'Accessible menus, dialogs, tabs and tooltips',
  },
  { name: 'Lucide', license: 'ISC', url: 'https://lucide.dev', use: 'Icons' },
  { name: 'clsx', license: 'MIT', url: 'https://github.com/lukeed/clsx', use: 'Class names' },
  { name: 'Astro', license: 'MIT', url: 'https://astro.build', use: 'This website' },
  {
    name: 'Fontsource',
    license: 'MIT (packaging); fonts under their own licenses',
    url: 'https://fontsource.org',
    use: 'Self-hosted font files',
  },
];
