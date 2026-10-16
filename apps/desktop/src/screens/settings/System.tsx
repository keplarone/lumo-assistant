import { Badge, Button, Callout, Input, Spinner } from '@lumo/ui';
import { FileText, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { dateTime } from '../../lib/format';
import { api, errorMessage, type AuditEntry, type IntegrationStatus, type OrderingApp } from '../../lib/ipc';
import { navigate, routeHref } from '../../lib/router';
import { useApp } from '../../state/app';
import appIcon from '../../assets/app-icon-512.png';
import { ExternalAnchor, useLocalStatus } from '../../components/LocalModels';
import { OPEN_SOURCE } from './Info';
import { SectionHeader } from './parts';

// ---- Integrations -------------------------------------------------------------------------------

const STATUS: Record<string, { label: string; tone: 'success' | 'neutral' | 'accent' | 'warning' }> = {
  connected: { label: 'Connected', tone: 'success' },
  not_connected: { label: 'Not connected', tone: 'neutral' },
  built_in: { label: 'Built in', tone: 'accent' },
  handoff: { label: 'Handoff', tone: 'warning' },
  upcoming: { label: 'Coming later', tone: 'neutral' },
};

/** Integrations the user connects here with a token, then Lumo verifies it. */
const VERIFIABLE = new Set(['github', 'netlify', 'brave']);
/** Model keys live in the Model section. */
const MODEL_IDS = new Set(['anthropic', 'openai_compatible']);

export function IntegrationsSection() {
  const app = useApp();
  const [items, setItems] = useState<IntegrationStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setItems(await api.integrationsStatus());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  return (
    <>
      <SectionHeader
        title="Integrations"
        description="Services Lumo can use for you. Nothing is shown as connected unless Lumo has checked it works."
      />
      {error && <Callout tone="danger">{error}</Callout>}
      {!items && !error && <Spinner label="Loading integrations" />}
      <ul className="lm-integrations">
        {items?.map((it) => (
          <IntegrationRow
            key={it.id}
            item={it}
            onChanged={async () => {
              await reload();
              await app.reloadSecrets();
            }}
          />
        ))}
      </ul>
      <OrderingAppsSection />
    </>
  );
}

// ---- Ordering apps ------------------------------------------------------------------------------

const CATEGORY: Record<string, string> = {
  food: 'Food delivery',
  groceries: 'Groceries',
  shopping: 'Shopping',
  rides: 'Rides',
  tables: 'Restaurant tables',
};

/** Apps Lumo orders with in the user's own browser. Lumo fills the cart; the user places the order. */
function OrderingAppsSection() {
  const [apps, setApps] = useState<OrderingApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setApps(await api.orderingApps());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  const groups = Object.keys(CATEGORY)
    .map((c) => ({ c, items: apps?.filter((a) => a.category === c) ?? [] }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="lm-ordering-apps">
      <SectionHeader
        title="Ordering apps"
        description="Sign in to an app in your browser and Lumo can order there for you: it fills the cart, then you check it and place the order. Your password and card stay with the app; Lumo never sees them."
      />
      {error && <Callout tone="danger">{error}</Callout>}
      {!apps && !error && <Spinner label="Loading ordering apps" />}
      {groups.map((g) => (
        <section key={g.c} aria-label={CATEGORY[g.c]}>
          <h3 className="lm-ordering-group">{CATEGORY[g.c]}</h3>
          <ul className="lm-integrations">
            {g.items.map((a) => (
              <OrderingAppRow key={a.id} app={a} onChanged={reload} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OrderingAppRow({ app, onChanged }: { app: OrderingApp; onChanged: () => Promise<void> }) {
  const [payment, setPayment] = useState(app.payment ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (what: string, f: () => Promise<void>, ok?: string) => {
    setBusy(what);
    setMessage(null);
    try {
      await f();
      if (ok) setMessage({ ok: true, text: ok });
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  return (
    <li className="lm-card lm-integration" data-status={app.connected ? 'connected' : 'not_connected'}>
      <div className="lm-integration-head">
        <span className="lm-integration-name">{app.name}</span>
        <Badge tone={app.connected ? 'success' : 'neutral'}>{app.connected ? 'Signed in' : 'Not set up'}</Badge>
        <span className="lm-row-meta">{app.regions}</span>
      </div>
      {!app.connected ? (
        <div className="lm-row-actions">
          <Button size="sm" variant="secondary" onClick={() => void run('open', () => api.openOrderingApp(app.id))}>
            Open {app.name} to sign in
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy === 'connect'}
            onClick={() => void run('connect', () => api.setOrderingAppConnected(app.id, true))}
          >
            I'm signed in
          </Button>
        </div>
      ) : (
        <>
          <form
            className="lm-secret-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                'payment',
                () => api.setOrderingAppPayment(app.id, payment),
                payment.trim() ? `Lumo will pick ${payment.trim()} at checkout.` : 'Lumo will leave payment as it is.',
              );
            }}
          >
            <Input
              value={payment}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPayment(e.target.value)}
              placeholder="Payment to pick, e.g. Apple Pay or Visa ending 4242"
              aria-label={`Payment method to pick in ${app.name}`}
            />
            <Button type="submit" variant="secondary" loading={busy === 'payment'}>
              Save
            </Button>
          </form>
          <p className="lm-integration-detail">
            Add your card in {app.name} itself. Lumo only needs its name so it can choose it at checkout.
          </p>
          <div className="lm-row-actions">
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'disconnect'}
              onClick={() => void run('disconnect', () => api.setOrderingAppConnected(app.id, false))}
            >
              Remove
            </Button>
          </div>
        </>
      )}
      {message && (
        <p className={message.ok ? 'lm-inline-ok' : 'lm-inline-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </li>
  );
}

function IntegrationRow({ item, onChanged }: { item: IntegrationStatus; onChanged: () => Promise<void> }) {
  const app = useApp();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const s = STATUS[item.status] ?? { label: item.status, tone: 'neutral' as const };
  const verifiable = VERIFIABLE.has(item.id) && item.secret;

  const connect = async () => {
    if (!item.secret) return;
    setBusy('connect');
    setMessage(null);
    try {
      await api.setSecret(item.secret, token.trim());
      setToken('');
      const account = await api.verifyIntegration(item.id);
      setMessage({ ok: true, text: `Connected as ${account}.` });
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };
  const check = async () => {
    setBusy('check');
    setMessage(null);
    try {
      const account = await api.verifyIntegration(item.id);
      setMessage({ ok: true, text: `Working. Account: ${account}.` });
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };
  const disconnect = async () => {
    setBusy('disconnect');
    setMessage(null);
    try {
      await api.disconnectIntegration(item.id);
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  return (
    <li className="lm-card lm-integration" data-status={item.status}>
      <div className="lm-integration-head">
        <span className="lm-integration-name">{item.name}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
        {item.account && item.status === 'connected' && (
          <span className="lm-row-meta lm-mono">{item.account}</span>
        )}
      </div>
      <p className="lm-integration-detail">{item.detail}</p>
      {MODEL_IDS.has(item.id) && (
        <a
          className="lm-link"
          href={routeHref({ name: 'settings', section: 'model' })}
          onClick={() => navigate({ name: 'settings', section: 'model' })}
        >
          Set up in Model settings
        </a>
      )}
      {verifiable && item.status !== 'connected' && (
        <form
          className="lm-secret-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void connect();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={item.id === 'brave' ? 'Paste your Brave Search API key' : 'Paste your access token'}
            aria-label={`${item.name} ${item.id === 'brave' ? 'API key' : 'token'}`}
            disabled={!!app.info.keychain}
          />
          <Button
            type="submit"
            variant="primary"
            loading={busy === 'connect'}
            disabled={!token.trim() || !!app.info.keychain}
          >
            Connect
          </Button>
        </form>
      )}
      {verifiable && item.status === 'connected' && (
        <div className="lm-row-actions">
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw />}
            loading={busy === 'check'}
            onClick={() => void check()}
          >
            Check connection
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'disconnect'} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      )}
      {message && (
        <p className={message.ok ? 'lm-inline-ok' : 'lm-inline-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </li>
  );
}

// ---- Activity log -------------------------------------------------------------------------------

const PAGE = 100;

export function ActivitySection() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before: number | null) => {
    setLoading(true);
    try {
      const page = await api.listAudit(PAGE, before);
      setRows((r) => (before === null ? page : [...r, ...page]));
      setDone(page.length < PAGE);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(null), [load]);

  return (
    <>
      <SectionHeader
        title="Activity log"
        description="Everything Lumo did on your behalf and every permission change, newest first. Secret values are never recorded."
      />
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="lm-table-wrap">
        <table className="lm-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">What</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="lm-nowrap">{dateTime(r.ts)}</td>
                <td>{r.actor === 'user' ? 'You' : r.actor === 'automation' ? 'Automation' : 'Lumo'}</td>
                <td className="lm-mono">{r.action}</td>
                <td className="lm-table-target" title={r.target ?? ''}>
                  {r.target ?? ''}
                </td>
                <td>
                  <Badge
                    tone={
                      r.outcome === 'ok'
                        ? 'success'
                        : r.outcome === 'denied'
                          ? 'warning'
                          : r.outcome === 'error'
                            ? 'danger'
                            : 'neutral'
                    }
                  >
                    {r.outcome}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && !loading && !error && <p className="lm-muted">Nothing recorded yet.</p>}
      <div className="lm-setting-block">
        {!done && rows.length > 0 && (
          <Button variant="secondary" loading={loading} onClick={() => void load(rows[rows.length - 1]!.id)}>
            Show older
          </Button>
        )}
        {loading && rows.length === 0 && <Spinner label="Loading" />}
      </div>
    </>
  );
}

// ---- About --------------------------------------------------------------------------------------

export function AboutSection() {
  const app = useApp();
  const [update, setUpdate] = useState<{ ok: boolean; text: string; version?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const check = async () => {
    setBusy('check');
    setUpdate(null);
    try {
      const v = await api.checkForUpdates();
      setUpdate(
        v
          ? { ok: true, text: `Version ${v} is available.`, version: v }
          : { ok: true, text: 'Lumo is up to date.' },
      );
    } catch (e) {
      setUpdate({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const install = async () => {
    setBusy('install');
    try {
      await api.installUpdate();
    } catch (e) {
      setUpdate({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="lm-about-head">
        <img src={appIcon} alt="" width={64} height={64} className="lm-about-icon" />
        <div>
          <h2 className="lm-settings-title">Lumo</h2>
          <p className="lm-page-sub">Version {app.info.version}</p>
        </div>
      </div>
      <dl className="lm-about">
        <div>
          <dt>Version</dt>
          <dd>{app.info.version}</dd>
        </div>
        <div>
          <dt>System</dt>
          <dd>{app.info.os}</dd>
        </div>
        <div>
          <dt>Keychain</dt>
          <dd>
            {app.info.keychain ? <span className="lm-inline-error">{app.info.keychain}</span> : 'Available'}
          </dd>
        </div>
        <div>
          <dt>Data folder</dt>
          <dd className="lm-mono">{app.info.dataDir}</dd>
        </div>
        <div>
          <dt>Logs</dt>
          <dd className="lm-mono">{app.info.logDir}</dd>
        </div>
      </dl>
      <div className="lm-setting-block lm-row-actions">
        <Button
          variant="secondary"
          icon={<FileText />}
          onClick={() => void api.openLogs().catch((e) => app.reportError(e, 'Couldn’t open the logs'))}
        >
          Open logs folder
        </Button>
        <Button
          variant="secondary"
          icon={<RefreshCw />}
          loading={busy === 'check'}
          onClick={() => void check()}
        >
          Check for updates
        </Button>
        {update?.version && (
          <Button variant="primary" loading={busy === 'install'} onClick={() => void install()}>
            Install and restart
          </Button>
        )}
      </div>
      {update && (
        <Callout tone={update.ok ? 'neutral' : 'warning'} className="lm-setting-block">
          {update.text}
        </Callout>
      )}
      <Licenses />
      {import.meta.env.DEV && (
        <p className="lm-setting-block">
          <a className="lm-link" href={routeHref({ name: 'styleguide' })}>
            Open the style guide (development builds only)
          </a>
        </p>
      )}
    </>
  );
}

function Licenses() {
  const local = useLocalStatus().status;
  // One row per distinct base model; the catalog comes from the Rust core.
  const models = local ? [...new Map(local.models.map((m) => [m.baseModel, m])).values()] : [];
  return (
    <>
      <h3 className="lm-section-title lm-about-subtitle">Open-source software</h3>
      <p className="lm-page-sub">Lumo is built with these projects, used under their licenses.</p>
      <dl className="lm-about lm-licenses">
        {OPEN_SOURCE.map(([name, license]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{license}</dd>
          </div>
        ))}
        <div>
          <dt>Rust crates</dt>
          <dd>MIT or Apache-2.0, listed with each release</dd>
        </div>
      </dl>
      <h3 className="lm-section-title lm-about-subtitle">On-device models</h3>
      {models.length > 0 ? (
        <dl className="lm-about lm-licenses">
          {models.map((m) => (
            <div key={m.baseModel}>
              <dt>{m.baseModel}</dt>
              <dd>
                <ExternalAnchor href={m.licenseUrl}>{m.license}</ExternalAnchor>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="lm-page-sub">
          The on-device models Lumo offers are open models released under the Apache-2.0 license.
        </p>
      )}
    </>
  );
}
