import { Badge, Button, EmptyState, StatusDot } from '@lumo/ui';
import { Activity, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, on, type ActiveRunInfo, type RunRecord } from '../lib/ipc';
import { relativeTime } from '../lib/format';
import { routeHref } from '../lib/router';
import { runStatusInfo } from '../lib/runState';
import { useApp } from '../state/app';

export function Tasks() {
  const app = useApp();
  const [active, setActive] = useState<ActiveRunInfo[]>([]);
  const [recent, setRecent] = useState<RunRecord[] | null>(null);
  const [stopping, setStopping] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api.listActiveRuns(), api.listRuns(50)]);
      setActive(a);
      setRecent(r);
    } catch (e) {
      app.reportError(e, 'Couldn’t load tasks');
    }
  }, [app]);

  useEffect(() => {
    void refresh();
    const subs = [
      on('runs-changed', () => void refresh()),
      on('agent-event', (env) => {
        if (env.event.type === 'run_started' || env.event.type === 'run_finished') void refresh();
      }),
      on('automations-changed', () => void refresh()),
    ];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, [refresh]);

  const stop = async (runId: string) => {
    try {
      await api.cancelRun(runId);
    } catch (e) {
      app.reportError(e, 'Couldn’t stop the task');
    }
  };
  const stopAll = async () => {
    setStopping(true);
    try {
      await api.stopAllRuns();
      await refresh();
    } catch (e) {
      app.reportError(e, 'Couldn’t stop tasks');
    } finally {
      setStopping(false);
    }
  };

  const activeIds = new Set(active.map((a) => a.runId));
  return (
    <div className="lm-page">
      <header className="lm-page-header">
        <div>
          <h1 className="lm-page-title">Tasks</h1>
          <p className="lm-page-sub">Everything Lumo is doing now, and what it did recently.</p>
        </div>
        <Button
          variant="danger"
          icon={<Square />}
          disabled={active.length === 0}
          loading={stopping}
          onClick={() => void stopAll()}
        >
          Stop all
        </Button>
      </header>

      <section className="lm-section" aria-labelledby="active-h">
        <h2 id="active-h" className="lm-section-title">
          Running now
        </h2>
        {active.length === 0 ? (
          <p className="lm-muted">Nothing is running.</p>
        ) : (
          <ul className="lm-rows">
            {active.map((r) => (
              <li key={r.runId} className="lm-row">
                <StatusDot tone="accent" pulse />
                <a className="lm-row-main" href={routeHref({ name: 'conversation', id: r.conversationId })}>
                  <span className="lm-row-title">{r.title}</span>
                  <span className="lm-row-meta">
                    {r.origin === 'automation' ? 'Automation · ' : ''}Started {relativeTime(r.startedAt)}
                  </span>
                </a>
                <Button size="sm" variant="secondary" icon={<Square />} onClick={() => void stop(r.runId)}>
                  Stop
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="lm-section" aria-labelledby="recent-h">
        <h2 id="recent-h" className="lm-section-title">
          Recent
        </h2>
        {recent && recent.filter((r) => !activeIds.has(r.id)).length === 0 ? (
          <EmptyState
            icon={<Activity />}
            title="No tasks yet"
            description="Tasks appear here when you ask Lumo to do something or an automation runs."
          />
        ) : (
          <ul className="lm-rows">
            {recent
              ?.filter((r) => !activeIds.has(r.id))
              .map((r) => {
                const s = runStatusInfo(r.status);
                return (
                  <li key={r.id} className="lm-row">
                    <StatusDot tone={s.tone} />
                    <a
                      className="lm-row-main"
                      href={routeHref({ name: 'conversation', id: r.conversationId })}
                    >
                      <span className="lm-row-title">{r.title ?? 'Conversation'}</span>
                      <span className="lm-row-meta">
                        {r.origin === 'automation' ? 'Automation · ' : ''}
                        {relativeTime(r.startedAt)}
                        {r.error ? ` · ${r.error}` : r.summary ? ` · ${r.summary}` : ''}
                      </span>
                    </a>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </li>
                );
              })}
          </ul>
        )}
      </section>
    </div>
  );
}
