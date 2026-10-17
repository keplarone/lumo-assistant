/**
 * Settings → Account: who is signed in, the plan linked to the account, and the optional extra
 * protection (passkeys and two-step verification), which Lumo recommends but never requires.
 */
import { Badge, Button, Callout, Dialog, Input } from '@lumo/ui';
import { Fingerprint, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api, errorMessage, type AccountStatus, type TwoStepSetup } from '../../lib/ipc';
import { planName } from '../../lib/plans';
import { routeHref } from '../../lib/router';
import { useApp } from '../../state/app';
import { SectionHeader, SettingRow } from './parts';
import '../../components/SignIn.css';

const METHODS: Record<string, string> = {
  GoogleOAuth: 'Google',
  Password: 'Email and password',
  Passkey: 'Passkey',
  MagicAuth: 'Email code',
};

export function AccountSection() {
  const app = useApp();
  const [st, setSt] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [twoStep, setTwoStep] = useState<'on' | 'off' | null>(null);

  useEffect(() => {
    api.accountStatus().then(setSt, (e) => setError(errorMessage(e)));
    // Refresh in the background so the plan and two-step state are current.
    api.accountRefresh().then(setSt, () => {});
  }, []);

  const run = async (what: string, fn: () => Promise<AccountStatus>) => {
    setBusy(what);
    setError(null);
    try {
      setSt(await fn());
      await app.reloadSettings();
    } catch (e) {
      if ((e as { code?: string })?.code !== 'cancelled') setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (st && !st.configured) {
    return (
      <>
        <SectionHeader title="Account" />
        <Callout>Accounts aren’t part of this build of Lumo.</Callout>
      </>
    );
  }
  const acc = st?.account ?? app.settings.account;

  return (
    <>
      <SectionHeader
        title="Account"
        description="Your Lumo account keeps your plan with you on any computer. Sign-in happens in your browser, so Lumo never sees your password."
      />
      {error && <Callout tone="danger">{error}</Callout>}
      {acc && (
        <>
          <section className="lm-setting-block" aria-labelledby="account-title">
            <h3 className="lm-section-title" id="account-title">
              Signed in
            </h3>
            <SettingRow
              label={acc.name ?? acc.email ?? 'Your account'}
              description={acc.name ? acc.email : undefined}
            >
              <Button
                icon={<LogOut />}
                loading={busy === 'out'}
                onClick={() => void run('out', api.accountSignOut)}
              >
                Sign out
              </Button>
            </SettingRow>
            {acc.method && (
              <SettingRow label="Signed in with">{METHODS[acc.method] ?? acc.method}</SettingRow>
            )}
            <SettingRow
              label="Plan"
              description={
                acc.licenseLinked
                  ? 'Linked to this account. It works on every computer you sign in on.'
                  : 'Buy a plan or enter a license key in Plans; it links to this account.'
              }
            >
              <a href={routeHref({ name: 'settings', section: 'plans' })}>{planName(app.settings.plan)}</a>
            </SettingRow>
          </section>

          <section className="lm-setting-block" aria-labelledby="security-title">
            <h3 className="lm-section-title" id="security-title">
              Extra protection
            </h3>
            <SettingRow
              label={<>Passkey {st?.recommendPasskey && <Badge tone="accent">Recommended</Badge>}</>}
              description={
                acc.method === 'Passkey'
                  ? 'You signed in with a passkey. Nobody can sign in as you without your device.'
                  : 'Sign in with your fingerprint, face or device PIN instead of a password. The sign-in page offers to add one; sign in again to set it up now.'
              }
            >
              {acc.method !== 'Passkey' && (
                <Button
                  icon={<Fingerprint />}
                  loading={busy === 'passkey'}
                  onClick={() => void run('passkey', () => api.accountSignIn('email'))}
                >
                  Add a passkey
                </Button>
              )}
            </SettingRow>
            <SettingRow
              label={
                <>
                  Two-step verification{' '}
                  {acc.twoStep ? (
                    <Badge tone="success">On</Badge>
                  ) : (
                    st?.recommendTwoStep && <Badge tone="accent">Recommended</Badge>
                  )}
                </>
              }
              description="After your password, also enter a code from an authenticator app (like Google Authenticator, 1Password or Authy)."
            >
              <Button icon={<ShieldCheck />} onClick={() => setTwoStep(acc.twoStep ? 'off' : 'on')}>
                {acc.twoStep ? 'Turn off' : 'Turn on'}
              </Button>
            </SettingRow>
          </section>

          <section className="lm-setting-block" aria-labelledby="delete-title">
            <h3 className="lm-section-title" id="delete-title">
              Delete account
            </h3>
            <SettingRow
              label="Delete your Lumo account"
              description="Removes your account and unlinks your plan. Conversations on this computer stay until you delete them. Cancel a paid plan on Whop."
            >
              <Button
                variant="danger"
                icon={<Trash2 />}
                loading={busy === 'delete'}
                onClick={() => void run('delete', api.accountDelete)}
              >
                Delete account
              </Button>
            </SettingRow>
          </section>
        </>
      )}
      {twoStep && (
        <TwoStepDialog
          mode={twoStep}
          onClose={(next) => {
            setTwoStep(null);
            if (next) {
              setSt(next);
              void app.reloadSettings();
            }
          }}
        />
      )}
    </>
  );
}

/** Turn two-step verification on (scan, then prove it with a code) or off (needs a current code). */
export function TwoStepDialog({
  mode,
  onClose,
}: {
  mode: 'on' | 'off';
  onClose: (st?: AccountStatus) => void;
}) {
  const codeId = useId();
  const [setup, setSetup] = useState<TwoStepSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(mode === 'on');

  useEffect(() => {
    if (mode !== 'on') return;
    api
      .twoStepStart()
      .then(setSetup, (e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }, [mode]);

  const close = () => {
    // An unconfirmed setup is removed so it can never lock anyone out.
    if (mode === 'on' && setup) void api.twoStepCancel().catch(() => {});
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onClose(await (mode === 'on' ? api.twoStepConfirm(code) : api.twoStepOff(code)));
    } catch (e) {
      setError(errorMessage(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={mode === 'on' ? 'Turn on two-step verification' : 'Turn off two-step verification'}
      description={
        mode === 'on'
          ? 'Scan this with your authenticator app, then enter the 6-digit code it shows.'
          : 'Enter a current code from your authenticator app.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={mode === 'on' ? 'primary' : 'danger'}
            loading={busy}
            disabled={code.replace(/\s/g, '').length !== 6 || (mode === 'on' && !setup)}
            onClick={() => void submit()}
          >
            {mode === 'on' ? 'Turn on' : 'Turn off'}
          </Button>
        </>
      }
    >
      <form
        className="lm-twostep"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {setup?.qrCode && (
          <img
            className="lm-twostep-qr"
            src={setup.qrCode}
            alt="QR code for your authenticator app"
            width={180}
            height={180}
          />
        )}
        {setup && (
          <p className="lm-row-meta">
            Can’t scan? Enter this key instead: <code className="lm-twostep-secret">{setup.secret}</code>
          </p>
        )}
        <label className="lm-setting-label" htmlFor={codeId}>
          6-digit code
        </label>
        <Input
          id={codeId}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
          autoFocus
        />
        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </Dialog>
  );
}
