/** Plans, Help, and Privacy & security: plain text screens that used to live on the website. */
import { Badge, Button, Callout, Input, Kbd, ProgressBar } from '@lumo/ui';
import { useEffect, useState } from 'react';
import { Bug, Check, ExternalLink } from 'lucide-react';
import { ExternalAnchor } from '../../components/LocalModels';
import { modKey } from '../../lib/format';
import { api, errorMessage, type LicenseStatus, type PlanUsage } from '../../lib/ipc';
import {
  asPlanId,
  checkoutUrl,
  nextPlan,
  PLAN_PRICES,
  planFeatures,
  planName,
  planRank,
  resetDate,
} from '../../lib/plans';
import { routeHref } from '../../lib/router';
import { useApp } from '../../state/app';
import { SectionHeader } from './parts';

export const ISSUES_URL = 'https://github.com/keplarone/lumo-assistant/issues/new';
export const PRIVACY_URL = 'https://lumo.keplar.one/privacy';
export const TERMS_URL = 'https://lumo.keplar.one/terms';

// ---- Plans --------------------------------------------------------------------------------------

/** "X% of this month's usage" with one bar, or "Unlimited usage". From plan_usage (Rust). */
export function UsageMeter({ usage }: { usage: PlanUsage }) {
  const unlimited = usage.percentUsed === null;
  return (
    <div className="lm-usage" aria-label="Usage">
      <div className="lm-usage-head">
        <span className="lm-usage-label">This month</span>
        <span className="lm-row-meta">
          {unlimited
            ? 'Unlimited usage'
            : `${usage.percentUsed}% of this month’s usage · Resets ${resetDate(usage.resetsAt)}`}
        </span>
      </div>
      {!unlimited && <ProgressBar value={(usage.percentUsed ?? 0) / 100} label="This month’s usage" />}
    </div>
  );
}

export function PlansSection() {
  const app = useApp();
  const usage = app.planUsage;
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.licenseStatus().then(setLic, (e) => setLoadError(errorMessage(e)));
    void app.reloadPlanUsage?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = asPlanId(lic?.plan ?? usage?.plan ?? app.settings.plan);
  const update = async (what: string, fn: () => Promise<LicenseStatus>, ok: (l: LicenseStatus) => string) => {
    setBusy(what);
    setMessage(null);
    try {
      const l = await fn();
      setLic(l);
      setKey('');
      setMessage({ ok: true, text: ok(l) });
      await app.reloadSettings();
      await app.reloadPlanUsage?.();
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const plans = usage?.plans ?? [];

  return (
    <>
      <SectionHeader
        title="Plans"
        description="Every plan shows how much of this month’s usage is used. Upgrade on Whop’s checkout page, then enter the license key you receive."
      />
      {loadError && <Callout tone="danger">{loadError}</Callout>}
      {usage && (
        <section className="lm-setting-block" aria-labelledby="usage-title">
          <h3 className="lm-section-title" id="usage-title">
            Usage
          </h3>
          <UsageMeter usage={usage} />
        </section>
      )}
      <ul className="lm-plans">
        {plans.map((p, i) => {
          const checkout = checkoutUrl(lic, p.id);
          const isCurrent = p.id === current;
          const { price, period } = PLAN_PRICES[p.id];
          return (
            <li key={p.id} className="lm-card lm-plan-card" data-current={isCurrent || undefined}>
              <div className="lm-plan-card-head">
                <h3 className="lm-plan-name">{p.name}</h3>
                {isCurrent && <Badge tone="accent">Your plan</Badge>}
              </div>
              <p className="lm-plan-price">
                <span>{price}</span>
                {period && <span className="lm-plan-period">{period}</span>}
              </p>
              {i > 0 && <p className="lm-plan-intro">Everything in {plans[i - 1]!.name}, plus</p>}
              <ul className="lm-plan-features">
                {planFeatures(plans, i).map((f) => (
                  <li key={f}>
                    <Check aria-hidden />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {planRank(p.id) > planRank(current) && (
                <div className="lm-plan-cta">
                  {checkout ? (
                    <Button
                      variant={p.id === nextPlan(current) ? 'primary' : 'secondary'}
                      icon={<ExternalLink />}
                      onClick={() =>
                        api
                          .openExternal(checkout)
                          .catch((e) => app.reportError(e, 'Couldn’t open the checkout page'))
                      }
                    >
                      Upgrade
                    </Button>
                  ) : (
                    lic && <p className="lm-row-meta">Checkout isn’t available in this build yet.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="lm-setting-block lm-license">
        <label className="lm-setting-label" htmlFor="license-key">
          License key
        </label>
        <div className="lm-setting-desc">
          {lic?.hasKey
            ? `A license key is saved for ${planName(current)}. It is stored in your system keychain.`
            : 'After you buy a plan, Whop gives you a license key. It is stored in your system keychain and never shown again.'}
        </div>
        {lic && !lic.licensingConfigured ? (
          <Callout tone="neutral">License activation isn’t available in this build yet.</Callout>
        ) : (
          <form
            className="lm-secret-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim())
                void update(
                  'activate',
                  () => api.activateLicense(key.trim()),
                  (l) => `${planName(l.plan)} is active.`,
                );
            }}
          >
            <Input
              id="license-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Enter license key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={!lic || !!app.info.keychain}
            />
            <Button
              type="submit"
              variant="secondary"
              loading={busy === 'activate'}
              disabled={!key.trim() || !lic}
            >
              Activate
            </Button>
          </form>
        )}
        {lic?.hasKey && (
          <Button
            variant="ghost"
            loading={busy === 'remove'}
            onClick={() =>
              void update(
                'remove',
                () => api.removeLicense(),
                () => 'License removed. You’re on the Free plan.',
              )
            }
          >
            Remove license
          </Button>
        )}
        {message && (
          <p
            className={message.ok ? 'lm-inline-ok' : 'lm-inline-error'}
            role={message.ok ? 'status' : 'alert'}
          >
            {message.text}
          </p>
        )}
      </div>
    </>
  );
}

// ---- Help ---------------------------------------------------------------------------------------

export function HelpSection() {
  const app = useApp();
  const mod = modKey();
  const shortcuts: [string[], string][] = [
    [
      app.settings.globalShortcut.split('+'),
      'Open the quick-ask window from anywhere (change it in General)',
    ],
    [[mod, 'N'], 'New task'],
    [[mod, 'K'], 'Search conversations'],
    [['Esc'], 'Close a dialog or the quick-ask window'],
    [[mod, 'Shift', 'Space'], 'Hold to talk'],
    [['Alt', 'Shift', 'Escape'], 'Take back control when Lumo is using your mouse and keyboard'],
  ];
  return (
    <>
      <SectionHeader
        title="Help"
        description="How to get started, and what to do when something goes wrong."
      />
      <h3 className="lm-section-title">Getting started</h3>
      <ol className="lm-help-steps">
        <li>
          <strong>Choose a model.</strong> Use a free on-device model that runs on this computer, or add an
          Anthropic API key for the most capable model.{' '}
          <a href={routeHref({ name: 'settings', section: 'model' })}>Model settings</a>
        </li>
        <li>
          <strong>Grant a folder.</strong> Lumo can only see folders you choose.{' '}
          <a href={routeHref({ name: 'settings', section: 'permissions' })}>Permissions</a>
        </li>
        <li>
          <strong>Ask for a task.</strong> Describe what you want in plain words, for example “Sort my
          Downloads by type”.
        </li>
        <li>
          <strong>Approve actions.</strong> Before Lumo changes anything, it shows you exactly what it will
          do. Nothing happens until you allow it.
        </li>
        <li>
          <strong>Undo.</strong> File changes from a task can be undone from the end of that task in the
          conversation.
        </li>
      </ol>
      <h3 className="lm-section-title">Keyboard shortcuts</h3>
      <dl className="lm-shortcuts">
        {shortcuts.map(([keys, what]) => (
          <div key={what}>
            <dt>
              <Kbd keys={keys} />
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <h3 className="lm-section-title">Something wrong?</h3>
      <p className="lm-page-sub">
        Describe what you did and what happened. Don’t include keys, passwords or private files. Logs are in
        the folder shown under About, if you choose to attach them.
      </p>
      <div className="lm-setting-block">
        <Button
          variant="secondary"
          icon={<Bug />}
          onClick={() =>
            api.openExternal(ISSUES_URL).catch((e) => app.reportError(e, `Couldn’t open ${ISSUES_URL}`))
          }
        >
          Report a problem
        </Button>
      </div>
    </>
  );
}

// ---- Privacy and security -----------------------------------------------------------------------

export function PrivacySection() {
  return (
    <>
      <SectionHeader
        title="Privacy & security"
        description="What stays on this computer, what leaves it, and how Lumo asks before it acts."
      />
      <h3 className="lm-section-title">Stays on this computer</h3>
      <ul className="lm-prose-list">
        <li>
          Your conversations, memories, automations and activity log, in a database encrypted with a random
          256-bit key.
        </li>
        <li>
          That database key and every API key or token you add, in your system keychain. Keys are never shown
          again, and Lumo’s interface can only see whether one is set.
        </li>
        <li>Recordings, until you stop recording. Read-aloud uses your computer’s own voices.</li>
        <li>Everything, when you use an on-device model: requests are answered on this computer.</li>
      </ul>
      <h3 className="lm-section-title">Sent to your model provider</h3>
      <ul className="lm-prose-list">
        <li>
          When you use Anthropic or another server: your messages, the files you attach, the results of the
          tools Lumo uses for the task (for example a folder listing), and a short context with the date and,
          if memory is on, what Lumo remembers about you.
        </li>
        <li>
          When you use voice input: the recording, to the speech-to-text service you set up under Voice.
        </li>
        <li>
          Integrations you connect (GitHub, Netlify, web search) receive only what a task sends to them.
        </li>
      </ul>
      <h3 className="lm-section-title">Approvals</h3>
      <ul className="lm-prose-list">
        <li>
          <strong>Reading</strong> inside folders you granted happens without asking. Lumo can’t see anything
          else.
        </li>
        <li>
          <strong>Changes</strong> such as moving or writing files ask first. You can allow once or for the
          rest of the conversation, and undo file changes afterwards.
        </li>
        <li>
          <strong>Sensitive actions</strong> such as using your mouse and keyboard are confirmed in a system
          dialog every time. Press Alt+Shift+Escape to take back control at any moment.
        </li>
      </ul>
      <Callout tone="neutral" className="lm-setting-block">
        Every action and permission change is recorded in the Activity log, without secret values.
      </Callout>
      <div className="lm-setting-block lm-row-actions">
        <ExternalAnchor href={PRIVACY_URL}>
          Privacy policy <ExternalLink aria-hidden />
        </ExternalAnchor>
        <ExternalAnchor href={TERMS_URL}>
          Terms of use <ExternalLink aria-hidden />
        </ExternalAnchor>
      </div>
    </>
  );
}

// ---- Licenses (used by About) -------------------------------------------------------------------

export const OPEN_SOURCE: [string, string][] = [
  ['Tauri', 'Apache-2.0 or MIT'],
  ['llama.cpp and ggml (the on-device engine)', 'MIT'],
  ['llama-cpp-rs bindings', 'MIT or Apache-2.0'],
  ['React', 'MIT'],
  ['three.js and React Three Fiber', 'MIT'],
  ['Radix UI', 'MIT'],
  ['CodeMirror', 'MIT'],
  ['marked', 'MIT'],
  ['DOMPurify', 'MPL-2.0 or Apache-2.0'],
  ['Lucide icons', 'ISC'],
  ['clsx', 'MIT'],
  ['Inter, Bricolage Grotesque and IBM Plex Mono fonts', 'SIL Open Font License 1.1'],
];
