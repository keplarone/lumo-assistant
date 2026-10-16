/**
 * Plan limits in chat: the refusal Rust sends when a plan doesn't include something or its monthly
 * usage is used up, with an Upgrade button that opens the real Whop checkout page, and a gentle
 * nudge once most of this month's usage is used. Rust enforces the limits; this only shows them.
 */
import { Button } from '@lumo/ui';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type LicenseStatus } from '../lib/ipc';
import { checkoutUrl, nextPlan, planName, resetDate } from '../lib/plans';
import { routeHref } from '../lib/router';
import { useApp } from '../state/app';

/** Opens Whop checkout for the plan one step up. Renders nothing when there is nothing to buy. */
export function UpgradeButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const app = useApp();
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  useEffect(() => {
    let live = true;
    api.licenseStatus().then(
      (l) => live && setLic(l),
      () => live && setLic(null),
    );
    return () => {
      live = false;
    };
  }, []);
  const next = lic ? nextPlan(lic.plan) : null;
  const url = next ? checkoutUrl(lic, next) : null;
  if (!next || !url) return null;
  return (
    <Button
      size={size}
      variant="primary"
      icon={<ExternalLink />}
      onClick={() =>
        api.openExternal(url).catch((e) => app.reportError(e, 'Couldn’t open the checkout page'))
      }
    >
      Upgrade to {planName(next)}
    </Button>
  );
}

const plansHref = routeHref({ name: 'settings', section: 'plans' });

/** A refused run or setting, with the way out. */
export function PlanLimitNotice({ message }: { message: string }) {
  return (
    <div className="lm-plan-limit" role="alert">
      <p className="lm-plan-limit-text">{message}</p>
      <div className="lm-plan-limit-actions">
        <UpgradeButton />
        <a className="lm-link" href={plansHref}>
          Compare plans
        </a>
      </div>
    </div>
  );
}

/** Shown under the message box once 80% of this month's usage is used. */
export function UsageNudge() {
  const usage = useApp().planUsage;
  const pct = usage?.percentUsed;
  if (!usage || pct == null || pct < 80) return null;
  return (
    <p className="lm-usage-nudge" role="status">
      {pct >= 100
        ? `You’ve used all of this month’s usage. It resets on ${resetDate(usage.resetsAt)}.`
        : `You’ve used ${pct}% of this month’s usage. It resets on ${resetDate(usage.resetsAt)}.`}{' '}
      <a className="lm-link" href={plansHref}>
        See plans
      </a>
    </p>
  );
}
