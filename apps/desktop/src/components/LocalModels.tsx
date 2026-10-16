/**
 * On-device models: the catalog the Rust core offers, run by Lumo's built-in engine. Nothing here is
 * inferred: what is downloaded, what fits and what runs the models all come from
 * local_models_status, and progress comes from 'local-model-progress' events.
 */
import { Badge, Button, Callout, Dialog, ProgressBar, Spinner } from '@lumo/ui';
import { Check, Cpu, Download, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  errorMessage,
  isApiError,
  on,
  type LocalModel,
  type LocalModelProgress,
  type LocalStatus,
} from '../lib/ipc';
import { acceleratorText, formatGb, memoryWarning, progressFraction, progressText } from '../lib/localModels';
import { planName, planShortName } from '../lib/plans';
import { routeHref } from '../lib/router';
import { useApp } from '../state/app';

type Confirm = { kind: 'download' | 'delete'; model: LocalModel } | null;

export function useLocalStatus() {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const reload = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.localModelsStatus());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  return { status, error, checking, reload };
}

export function ExternalAnchor({
  href,
  children,
  className = 'lm-link',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const app = useApp();
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        api.openExternal(href).catch((err) => app.reportError(err, `Couldn’t open ${href}`));
      }}
    >
      {children}
    </a>
  );
}

export function LocalModels({
  variant = 'settings',
  onSelected,
}: {
  variant?: 'settings' | 'onboarding';
  onSelected?: (m: LocalModel) => void;
}) {
  const app = useApp();
  const { status, error, checking, reload } = useLocalStatus();
  const [progress, setProgress] = useState<LocalModelProgress | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const announcedFor = useRef<string | null>(null);

  useEffect(() => {
    const un = on('local-model-progress', (p) => {
      if (p.done) {
        setProgress(null);
        setDownloading(null);
        return;
      }
      setProgress(p);
      setDownloading(p.model);
    });
    return () => void un.then((f) => f());
  }, []);

  const download = async (m: LocalModel) => {
    setRowError(null);
    setDownloading(m.id);
    setProgress(null);
    if (announcedFor.current !== m.id) {
      announcedFor.current = m.id;
      app.announce(`Downloading ${m.displayName}.`);
    }
    try {
      await api.downloadLocalModel(m.id);
      app.announce(`${m.displayName} is downloaded.`);
    } catch (e) {
      if (isApiError(e) && e.code === 'cancelled') app.announce('Download cancelled.');
      else setRowError({ id: m.id, text: errorMessage(e) });
    } finally {
      announcedFor.current = null;
      setDownloading(null);
      setProgress(null);
      await reload();
    }
  };

  const act = async (id: string, what: string, fn: () => Promise<void>) => {
    setBusy(`${what}:${id}`);
    setRowError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setRowError({ id, text: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
      await reload();
    }
  };

  const select = async (m: LocalModel) => {
    if (
      await act(m.id, 'select', async () => {
        await api.selectLocalModel(m.id);
        await app.reloadSettings();
      })
    ) {
      app.announce(`Lumo now uses ${m.displayName}.`);
      onSelected?.(m);
    }
  };

  if (!status) {
    return error ? (
      <Callout tone="danger" title="Couldn’t check on-device models">
        {error}
      </Callout>
    ) : (
      <Spinner label="Checking on-device models" />
    );
  }

  const brand = status.brand;
  return (
    <section className="lm-local" aria-label={brand} data-variant={variant}>
      <p className="lm-local-intro">
        {brand} are free, private and work offline: they run on this computer, so nothing you ask leaves it
        and there is no cost per request. They are less capable than Claude on hard, multi-step tasks.
      </p>

      <div className="lm-local-runtime">
        <Badge tone="success" icon={<Cpu />}>
          Built in · {acceleratorText(status.accelerator)}
        </Badge>
        {status.memoryGb > 0 && (
          <span className="lm-row-meta">This computer has {status.memoryGb} GB of memory</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw />}
          loading={checking}
          onClick={() => void reload()}
        >
          Refresh
        </Button>
      </div>
      {error && <p className="lm-inline-error">{error}</p>}

      <ul className="lm-local-list">
        {status.models.map((m) => {
          const isDownloading = downloading === m.id;
          const otherDownloading = !!downloading && !isDownloading;
          const warn = memoryWarning(m, status.memoryGb);
          const p = isDownloading ? progress : null;
          // Rust refuses choosing a model the plan doesn't include; this only says so up front.
          const locked = m.requiredPlan ?? null;
          return (
            <li key={m.id} className="lm-card lm-local-model" data-selected={m.selected || undefined}>
              <div className="lm-local-model-main">
                <div className="lm-local-model-head">
                  <span className="lm-local-model-name">{m.displayName}</span>
                  {m.selected && (
                    <Badge tone="accent" icon={<Check />}>
                      In use
                    </Badge>
                  )}
                  {m.installed && !m.selected && <Badge tone="success">Downloaded</Badge>}
                  {locked && <Badge tone="accent">{planShortName(locked)}</Badge>}
                </div>
                <div className="lm-local-model-attr">
                  Based on {m.baseModel} ·{' '}
                  <ExternalAnchor href={m.licenseUrl} className="lm-local-license">
                    {m.license}
                  </ExternalAnchor>
                  {' · '}
                  {formatGb(m.downloadGb)} download
                  {m.partialBytes > 0 && !m.installed && !isDownloading && (
                    <> · {formatGb(m.partialBytes / 1e9)} already downloaded</>
                  )}
                </div>
                <p className="lm-local-model-summary">{m.summary}</p>
                {warn && !locked && <p className="lm-local-model-warn">{warn}</p>}
                {locked && (
                  <p className="lm-row-meta">
                    Included with {planName(locked)} and above.{' '}
                    <a className="lm-link" href={routeHref({ name: 'settings', section: 'plans' })}>
                      See plans
                    </a>
                  </p>
                )}
                {isDownloading && (
                  <div className="lm-local-progress" aria-live="polite">
                    <ProgressBar value={progressFraction(p)} label={`Downloading ${m.displayName}`} />
                    <span className="lm-row-meta">{progressText(p)}</span>
                  </div>
                )}
                {rowError?.id === m.id && (
                  <p className="lm-inline-error" role="alert">
                    {rowError.text}
                  </p>
                )}
              </div>
              <div className="lm-local-model-actions">
                {isDownloading ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<X />}
                    onClick={() =>
                      void api.cancelLocalDownload().catch((e) => app.reportError(e, 'Couldn’t cancel'))
                    }
                  >
                    Cancel
                  </Button>
                ) : m.installed ? (
                  <>
                    {!m.selected && !locked && (
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busy === `select:${m.id}`}
                        onClick={() => void select(m)}
                      >
                        Use this model
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 />}
                      aria-label={`Delete ${m.displayName}`}
                      disabled={!!busy}
                      onClick={() => setConfirm({ kind: 'delete', model: m })}
                    >
                      Delete
                    </Button>
                  </>
                ) : locked ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download />}
                    disabled={otherDownloading}
                    title={otherDownloading ? 'One download at a time' : undefined}
                    onClick={() => (m.fits ? void download(m) : setConfirm({ kind: 'download', model: m }))}
                  >
                    {m.partialBytes > 0 ? 'Resume download' : 'Download'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={confirm?.kind === 'download'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Download ${confirm?.model.displayName ?? ''} anyway?`}
        description={
          confirm
            ? `${memoryWarning(confirm.model, status.memoryGb)} It may run very slowly or fail to load. The download is ${formatGb(confirm.model.downloadGb)}.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const m = confirm!.model;
                setConfirm(null);
                void download(m);
              }}
            >
              Download anyway
            </Button>
          </>
        }
      />
      <Dialog
        open={confirm?.kind === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${confirm?.model.displayName ?? ''}?`}
        description={
          confirm
            ? `This frees about ${formatGb(confirm.model.downloadGb)}. You can download it again later.${confirm.model.selected ? ' Lumo won’t be able to answer until you choose another model.' : ''}`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const m = confirm!.model;
                setConfirm(null);
                void act(m.id, 'delete', () => api.deleteLocalModel(m.id));
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}
