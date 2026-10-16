/**
 * How the Plans screen and chat describe plans. Every limit comes from Rust's plans table through
 * plan_usage; only prices and wording live here. Rust enforces the limits, this only displays them.
 */
import type { LicenseStatus, PlanId, PlanInfo } from './ipc';

export const PLAN_ORDER: PlanId[] = ['free', 'lite', 'pro', 'unlimited'];

export const PLAN_PRICES: Record<PlanId, { price: string; period?: string }> = {
  free: { price: '$0' },
  lite: { price: '$19.99', period: '/month' },
  pro: { price: '$49.99', period: '/month' },
  unlimited: { price: '$124.99', period: '/month' },
};

const NAMES: Record<PlanId, string> = {
  free: 'Free',
  lite: 'Lumo Lite',
  pro: 'Lumo Pro',
  unlimited: 'Lumo Unlimited',
};

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
  if (p === 'unlimited') return lic.checkoutUnlimited;
  return null;
}

/** "November 1", in the user's locale. */
export function resetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'the 1st of next month';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric' });
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "30× more usage than Free", "Unlimited usage". */
export function usageLine(plan: PlanInfo, plans: PlanInfo[]): string {
  if (plan.monthlyTokens === null) return 'Unlimited usage';
  const free = plans.find((p) => p.id === 'free')?.monthlyTokens;
  if (plan.id === 'free' || !free) return 'A monthly usage allowance, renewed on the 1st';
  return `${Math.round(plan.monthlyTokens / free)}× more usage than Free`;
}

/** What a plan adds over the one before it (or everything, for the first). */
export function planFeatures(plans: PlanInfo[], index: number): string[] {
  const p = plans[index]!;
  const prev = index > 0 ? plans[index - 1] : undefined;
  const out = [usageLine(p, plans)];
  if (!prev || prev.localModels.join() !== p.localModels.join())
    out.push(
      prev ? `All on-device models: ${list(p.localModels)}` : `On-device models: ${list(p.localModels)}`,
    );
  if (p.cloudModels && !prev?.cloudModels) out.push('Cloud models: Anthropic or any compatible server');
  if (!prev || prev.automations !== p.automations)
    out.push(
      p.automations === null
        ? 'Unlimited automations'
        : `${p.automations} automation${p.automations === 1 ? '' : 's'}`,
    );
  if (p.computerControl && !prev?.computerControl) out.push('Lumo can use your mouse and keyboard');
  if (!prev) out.push('Conversations, files, places and order handoff', 'The Lumo owl');
  return out;
}
