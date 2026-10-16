import { SITE } from './site';
import { release } from './downloads';
import { planOffers } from './plans';

/**
 * JSON-LD for the app. Deliberately has no rating or review fields: there are none to report.
 * Offers come from plans.ts.
 * softwareVersion is only included once a version is released.
 */
export function softwareApplication(site: URL | undefined) {
  const origin = site?.href ?? `${SITE.url}/`;
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
    offers: planOffers(),
    ...(release.released && release.version ? { softwareVersion: release.version } : {}),
  };
}
