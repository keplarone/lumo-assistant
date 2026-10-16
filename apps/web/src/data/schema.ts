import { SITE } from './site';
import { release } from './downloads';

/**
 * JSON-LD for the app. Deliberately has no rating or review fields: there are none to report.
 * softwareVersion is only included once a version is released.
 */
export function softwareApplication(site: URL | undefined) {
  const origin = site?.href ?? 'https://lumo.keplar.one/';
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE.fullName,
    alternateName: SITE.name,
    description: SITE.description,
    applicationCategory: 'ProductivityApplication',
    operatingSystem: 'Windows, macOS, Linux',
    url: origin,
    downloadUrl: new URL('/download/', origin).href,
    image: new URL('/og.png', origin).href,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    ...(release.released && release.version ? { softwareVersion: release.version } : {}),
  };
}
