/**
 * How the Plans screen and chat describe plans. Every limit and price comes from Rust's plans table
 * and the model gateway's catalog through plan_usage; only wording lives here. The gateway and Rust
 * enforce the limits, this only displays them.
 */
import type { CatalogModel, LicenseStatus, PlanId, PlanInfo } from './ipc';

export const PLAN_ORDER: PlanId[] = ['free', 'lite', 'pro'];

const NAMES: Record<PlanId, string> = {
  free: 'Free',
  lite: 'Lumo Lite',
  pro: 'Lumo Pro',
};

/** "$0", or "$19.99" with "/month". */
export function planPrice(p: PlanInfo): { price: string; period?: string } {
  if (p.priceUsd <= 0) return { price: '$0' };
  return { price: `$${p.priceUsd.toFixed(2)}`, period: '/month' };
}

export function asPlanId(p: string | null | undefined): PlanId {
  return PLAN_ORDER.includes(p as PlanId) ? (p as PlanId) : 'free';
}

export function planName(p: string | null | undefined): string {
  return NAMES[asPlanId(p)];
}

/** "Lite", "Pro": the short label used on badges. */
export function planShortName(p: string | null | undefined): string {
  return planName(p).replace(/^Lumo /, '');
}

export function planRank(p: string | null | undefined): number {
  return PLAN_ORDER.indexOf(asPlanId(p));
}

/** The plan one step up, or null on the top plan. */
export function nextPlan(p: string | null | undefined): PlanId | null {
  return PLAN_ORDER[planRank(p) + 1] ?? null;
}

/** The Whop checkout page for a plan, from the license status Rust reports. */
export function checkoutUrl(lic: LicenseStatus | null, p: PlanId): string | null {
  if (!lic) return null;
  if (p === 'lite') return lic.checkoutLite;
  if (p === 'pro') return lic.checkoutPro;
  return null;
}

/** "November 1", in the user's locale. */
export function resetDate(iso: string | null): string {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return 'the 1st of next month';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const USAGE: Record<PlanId, string> = {
  free: 'Free AI models, with a monthly allowance',
  lite: 'Faster, smarter models and a much bigger monthly allowance',
  pro: 'The strongest models and about three times Lite’s allowance',
};

/** What a plan adds over the one before it (or everything, for the first). */
export function planFeatures(plans: PlanInfo[], index: number): string[] {
  const p = plans[index]!;
  const prev = index > 0 ? plans[index - 1] : undefined;
  const out = [USAGE[p.id]];
  const before = new Set(prev?.models.map((m) => m.id) ?? []);
  const added = p.models.filter((m) => !before.has(m.id)).map((m) => m.name);
  if (added.length) out.push(`${prev ? 'Adds' : 'Models:'} ${list(added)}`);
  if (!prev || prev.automations !== p.automations)
    out.push(
      p.automations === null
        ? 'Unlimited automations'
        : `${p.automations} automation${p.automations === 1 ? '' : 's'}`,
    );
  if (p.computerControl && !prev?.computerControl) out.push('Lumo can use your mouse and keyboard');
  if (!prev || prev.priceWatches !== p.priceWatches)
    out.push(p.priceWatches === null ? 'Unlimited price watches' : `${p.priceWatches} price watches`);
  if (!prev)
    out.push(
      'Conversations, files, places and order handoff',
      'Reminders, a morning brief and bill warnings',
      'The Lumo owl',
    );
  return out;
}

/** The model "Auto" would use, and the plan's models, for the model picker. */
export function planModels(
  plans: PlanInfo[],
  plan: PlanId,
): { auto: CatalogModel | null; models: CatalogModel[] } {
  const p = plans.find((x) => x.id === plan);
  const models = p?.models ?? [];
  return { auto: models.find((m) => m.id === p?.defaultModel) ?? models[0] ?? null, models };
}

/** A model's display name from any plan, or its id. */
export function modelName(plans: PlanInfo[], id: string): string {
  return plans.flatMap((p) => p.models).find((m) => m.id === id)?.name ?? id;
}
