import { SITE } from './site';
import { RELEASE } from './release';

/**
 * JSON-LD for the app. No offers, ratings or reviews: there are none to report.
 * softwareVersion is only included once a version is published in release.ts.
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
    downloadUrl: origin,
    image: new URL('/og.png', origin).href,
    ...(RELEASE.version ? { softwareVersion: RELEASE.version } : {}),
  };
}
