/**
 * The single source of truth for Lumo's plans. The pricing page, the homepage teaser and the JSON-LD
 * all read from here.
 *
 * Rules for this file:
 * - No invented quotas, model names or trial lengths: limits are described as "limited", "more",
 *   "highest" until the owner publishes real numbers.
 * - Plans open at launch. Nothing can be bought yet, so there are no checkout links.
 * - Features that map to a capability carry its id, so the page shows that capability's real status
 *   (from capabilities.ts) next to the feature.
 */
import type { CapabilityId } from './capabilities';

/**
 * Billing period, confirmed monthly by the owner. Change it here only.
 * `suffix` is shown after prices, `unitCode` is the UN/CEFACT code used in JSON-LD (MON = month).
 */
export const BILLING_PERIOD = { suffix: '/month', label: 'per month, billed monthly', unitCode: 'MON', isoDuration: 'P1M' } as const;

export const CURRENCY = 'USD';

/** Shown on every plan while Lumo is pre-release. */
export const PLAN_AVAILABILITY = 'At launch';

export interface PlanFeature {
  text: string;
  capability?: CapabilityId;
}

export interface Plan {
  id: 'free' | 'lite' | 'pro';
  name: string;
  /** Monthly price in USD, as a string to keep exact cents. */
  price: string;
  tagline: string;
  /** "Everything in X" line, if the plan builds on another. */
  includes?: string;
  features: PlanFeature[];
  highlighted?: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '0',
    tagline: 'Try Lumo with a limited number of tasks each month.',
    features: [
      { text: 'Core desktop assistant with a limited number of tasks each month' },
      { text: 'Lumo Local models that run on your computer', capability: 'on-device-models' },
      { text: 'Conversations', capability: 'conversations' },
      { text: 'File organizing in folders you allow', capability: 'files' },
      { text: 'Finding places', capability: 'restaurant-finder' },
      { text: 'Order handoff to the provider', capability: 'restaurant-finder' },
      { text: 'Lumo, the mascot', capability: 'mascot' },
    ],
  },
  {
    id: 'lite',
    name: 'Lumo Lite',
    price: '19.99',
    tagline: 'For everyday use.',
    includes: 'Everything in Free, plus',
    highlighted: true,
    features: [
      { text: 'More tasks each month' },
      { text: 'Automations', capability: 'automations' },
      { text: 'Projects with live preview and version history', capability: 'project-workspace' },
      { text: 'Voice input', capability: 'voice' },
    ],
  },
  {
    id: 'pro',
    name: 'Lumo Pro',
    price: '49.99',
    tagline: 'For people who build and automate.',
    includes: 'Everything in Lite, plus',
    features: [
      { text: 'The highest limits' },
      { text: 'The most capable model' },
      { text: 'Publishing to GitHub', capability: 'github' },
      { text: 'Publishing to Netlify', capability: 'netlify' },
      { text: 'Custom agents', capability: 'custom-agents' },
      { text: 'Priority support' },
    ],
  },
];

export function formatPrice(p: Plan): string {
  return `$${p.price}`;
}

/** JSON-LD offers for the SoftwareApplication. No availability is claimed: nothing is on sale yet. */
export function planOffers() {
  return PLANS.map((p) => ({
    '@type': 'Offer',
    name: p.name,
    description: p.tagline,
    price: p.price,
    priceCurrency: CURRENCY,
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: p.price,
      priceCurrency: CURRENCY,
      billingDuration: BILLING_PERIOD.isoDuration,
      referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: BILLING_PERIOD.unitCode },
    },
  }));
}
