import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  SegmentedControl,
  Select,
  Spinner,
  StatusDot,
  Switch,
  Textarea,
} from '@lumo/ui';
import { ChevronDown, ChevronRight, Pencil, Play, Plus, Timer, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  describeTrigger,
  emptyForm,
  formFromAutomation,
  inputFromForm,
  TOOL_EXPLANATIONS,
  validateForm,
  WEEKDAYS,
  type AutomationForm,
  type FormErrors,
  type TriggerKind,
} from '../lib/automationForm';
import { dateTime, relativeTime } from '../lib/format';
import { api, errorMessage, on, type Automation, type AutomationRun } from '../lib/ipc';
import { routeHref } from '../lib/router';
import { runStatusInfo } from '../lib/runState';
import { useApp } from '../state/app';

export function Automations() {
  const app = useApp();
  const [items, setItems] = useState<Automation[] | null>(null);
  const [allowable, setAllowable] = useState<string[]>([]);
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const reload = useCallback(async () => {
    try {
      setItems(await api.listAutomations());
      setHistoryKey((k) => k + 1);
    } catch (e) {
      app.reportError(e, 'Couldn’t load automations');
      setItems([]);
    }
  }, [app]);

  useEffect(() => {
    void reload();
    api.allowableAutomationTools().then(setAllowable, () => setAllowable([]));
    const sub = on('automations-changed', () => void reload());
    return () => void sub.then((u) => u());
  }, [reload]);

  const toggleEnabled = async (a: Automation, enabled: boolean) => {
    try {
      await api.saveAutomation(a.id, { ...inputFromForm(formFromAutomation(a)), enabled });
      await reload();
    } catch (e) {
      app.reportError(e, 'Couldn’t update the automation');
    }
  };
  const runNow = async (a: Automation) => {
    try {
      await api.runAutomation(a.id);
      app.announce(`${a.name} started.`);
    } catch (e) {
      app.reportError(e, 'Couldn’t start the automation');
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await api.deleteAutomation(deleting.id);
      setDeleting(null);
      await reload();
    } catch (e) {
      app.reportError(e, 'Couldn’t delete the automation');
    }
  };

  const paused = app.settings.automationsPaused;

  return (
    <div className="lm-page">
      <header className="lm-page-header">
        <div>
          <h1 className="lm-page-title">Automations</h1>
          <p className="lm-page-sub">
            Requests Lumo runs on a schedule, even when you’re not watching. They can read and look things up;
            they only change things you allow, and anything sensitive waits for you.
          </p>
        </div>
        <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
          New automation
        </Button>
      </header>

      <div className="lm-setting-row lm-pause-row">
        <div>
          <div className="lm-setting-label" id="pause-label">
            Pause all automations
          </div>
          <div className="lm-setting-desc">
            {paused
              ? 'Nothing runs on schedule until you resume. “Run now” still works.'
              : 'Scheduled automations run as planned.'}
          </div>
        </div>
        <Switch
          checked={paused}
          aria-label="Pause all automations"
          onCheckedChange={(v) =>
            void app
              .updateSettings({ automationsPaused: v })
              .catch((e) => app.reportError(e, 'Couldn’t change this setting'))
          }
        />
      </div>

      {items === null ? (
        <Spinner label="Loading automations" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Timer />}
          title="No automations yet"
          description="For example: every weekday at 8:00, check my Downloads folder and tell me what arrived."
          actions={
            <Button variant="secondary" icon={<Plus />} onClick={() => setEditing('new')}>
              New automation
            </Button>
          }
        />
      ) : (
        <ul className="lm-automations">
          {items.map((a) => {
            const status = a.lastStatus ? runStatusInfo(a.lastStatus) : null;
            const attention = a.lastStatus === 'needs_attention' || a.lastStatus === 'failed';
            return (
              <li key={a.id} className="lm-card lm-automation" data-attention={attention || undefined}>
                <div className="lm-automation-main">
                  <div className="lm-automation-head">
                    <span className="lm-automation-name">{a.name}</span>
                    {!a.enabled && <Badge>Off</Badge>}
                    {status && <Badge tone={status.tone}>{status.label}</Badge>}
                  </div>
                  <p className="lm-automation-prompt">{a.prompt}</p>
                  <div className="lm-row-meta">
                    {describeTrigger(a.trigger)}
                    {a.enabled && a.nextRunAt && !paused && ` · Next ${relativeTime(a.nextRunAt)}`}
                    {a.enabled && paused && ' · Paused'}
                    {a.lastRunAt && ` · Last ran ${relativeTime(a.lastRunAt)}`}
                    {a.allowedTools.length > 0 && ` · May use ${a.allowedTools.join(', ')}`}
                  </div>
                  {a.lastStatus === 'needs_attention' && (
                    <Callout tone="warning">
                      It stopped at a step that needs your approval. Open the last run to continue it
                      yourself, or allow that action in the automation.
                    </Callout>
                  )}
                </div>
                <div className="lm-automation-actions">
                  <Switch
                    checked={a.enabled}
                    onCheckedChange={(v) => void toggleEnabled(a, v)}
                    aria-label={`${a.name} enabled`}
                  />
                  <Button size="sm" variant="secondary" icon={<Play />} onClick={() => void runNow(a)}>
                    Run now
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(a)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 />}
                    onClick={() => setDeleting(a)}
                    aria-label={`Delete ${a.name}`}
                  />
                </div>
                <button
                  type="button"
                  className="lm-activity-toggle lm-automation-history-toggle"
                  aria-expanded={expanded === a.id}
                  onClick={() => setExpanded((x) => (x === a.id ? null : a.id))}
                >
                  {expanded === a.id ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                  History
                </button>
                {expanded === a.id && <AutomationHistory id={a.id} refreshKey={historyKey} />}
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <AutomationEditor
          automation={editing === 'new' ? null : editing}
          allowable={allowable}
          onClose={() => setEditing(null)}
          onSaved={() => void reload()}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="It stops running. Conversations from earlier runs are kept."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

function AutomationHistory({ id, refreshKey }: { id: string; refreshKey: number }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listAutomationRuns(id).then(setRuns, (e) => setError(errorMessage(e)));
  }, [id, refreshKey]);
  if (error) return <p className="lm-inline-error">{error}</p>;
  if (!runs) return <Spinner label="Loading history" />;
  if (runs.length === 0) return <p className="lm-muted lm-automation-history">It hasn’t run yet.</p>;
  return (
    <ul className="lm-rows lm-automation-history">
      {runs.map((r) => {
        const s = runStatusInfo(r.status);
        return (
          <li key={r.id} className="lm-row">
            <StatusDot tone={s.tone} pulse={r.status === 'running'} />
            <div className="lm-row-main">
              <span className="lm-row-title">
                {dateTime(r.startedAt)} · {s.label}
              </span>
              {(r.error || r.summary) && <span className="lm-row-meta">{r.error ?? r.summary}</span>}
            </div>
            {r.conversationId && (
              <a className="lm-link" href={routeHref({ name: 'conversation', id: r.conversationId })}>
                Open conversation
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AutomationEditor({
  automation,
  allowable,
  onClose,
  onSaved,
}: {
  automation: Automation | null;
  allowable: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const [form, setForm] = useState<AutomationForm>(() =>
    automation ? formFromAutomation(automation) : emptyForm(),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const set = <K extends keyof AutomationForm>(k: K, v: AutomationForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const e = validateForm(form, allowable);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api.saveAutomation(automation?.id ?? null, inputFromForm(form));
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={automation ? 'Edit automation' : 'New automation'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="lm-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" error={errors.name}>
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={100}
            placeholder="Morning downloads check"
            autoFocus
          />
        </Field>
        <Field
          label="What should Lumo do?"
          description="Write it as you would ask Lumo yourself."
          error={errors.prompt}
        >
          <Textarea
            value={form.prompt}
            onChange={(e) => set('prompt', e.target.value)}
            rows={3}
            autoSize
            maxRows={8}
            placeholder="Check my Downloads folder and tell me what arrived since yesterday."
          />
        </Field>
        {app.agents.length > 0 && (
          <div className="lm-field-inline">
            <span className="lu-field-label">Assistant</span>
            <Select
              aria-label="Assistant"
              value={form.agentId ?? 'default'}
              onValueChange={(v) => set('agentId', v === 'default' ? null : v)}
              options={[
                { value: 'default', label: 'Lumo' },
                ...app.agents.map((a) => ({ value: a.id ?? '', label: a.name })),
              ]}
            />
          </div>
        )}
        <fieldset className="lm-fieldset">
          <legend className="lu-field-label">When</legend>
          <SegmentedControl<TriggerKind>
            label="Schedule type"
            value={form.kind}
            onValueChange={(v) => set('kind', v)}
            options={[
              { value: 'daily', label: 'At a time' },
              { value: 'interval', label: 'Every few minutes' },
              { value: 'cron', label: 'Advanced' },
            ]}
          />
          {form.kind === 'daily' && (
            <div className="lm-trigger-daily">
              <Field label="Time" error={errors.time}>
                <Input
                  type="time"
                  value={form.time}
                  onChange={(e) => set('time', e.target.value)}
                  className="lm-time-input"
                />
              </Field>
              <div className="lm-field-inline">
                <span className="lu-field-label" id="days-label">
                  Days
                </span>
                <div className="lm-days" role="group" aria-labelledby="days-label">
                  {WEEKDAYS.map((d) => {
                    const on = form.days.includes(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className="lm-day"
                        aria-pressed={on}
                        aria-label={d.long}
                        title={d.long}
                        onClick={() =>
                          set('days', on ? form.days.filter((x) => x !== d.id) : [...form.days, d.id])
                        }
                      >
                        {d.short}
                      </button>
                    );
                  })}
                </div>
                <span className="lu-field-description">
                  {form.days.length === 0 || form.days.length === 7
                    ? 'Every day'
                    : `${form.days.length} days a week`}
                </span>
              </div>
            </div>
          )}
          {form.kind === 'interval' && (
            <Field
              label="Every"
              description="Minutes between runs, from 5 to 10,080 (7 days)."
              error={errors.minutes}
            >
              <Input
                inputMode="numeric"
                value={form.minutes}
                onChange={(e) => set('minutes', e.target.value)}
                className="lm-number-input"
              />
            </Field>
          )}
          {form.kind === 'cron' && (
            <Field
              label="Cron expression"
              description="Six fields with seconds: sec min hour day month weekday. Example: 0 30 8 * * Mon-Fri"
              error={errors.expression}
            >
              <Input
                value={form.expression}
                onChange={(e) => set('expression', e.target.value)}
                spellCheck={false}
                className="lm-mono-input"
              />
            </Field>
          )}
        </fieldset>
        <fieldset className="lm-fieldset">
          <legend className="lu-field-label">What it may change without asking</legend>
          <p className="lu-field-description">
            Automations can always read your granted folders and look things up. Choose the changes it may
            make on its own. Sensitive actions (running commands, checkout or sign-in pages, large deletions,
            screen capture) are never allowed in the background: the automation stops and waits for you.
          </p>
          <ul className="lm-checks">
            {allowable.map((t) => (
              <li key={t}>
                <label className="lm-check">
                  <Checkbox
                    checked={form.allowedTools.includes(t)}
                    onCheckedChange={(c) =>
                      set(
                        'allowedTools',
                        c ? [...form.allowedTools, t] : form.allowedTools.filter((x) => x !== t),
                      )
                    }
                  />
                  <span>
                    <span className="lm-check-name">{t}</span>
                    <span className="lm-check-desc">{TOOL_EXPLANATIONS[t] ?? ''}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {errors.allowedTools && <p className="lm-inline-error">{errors.allowedTools}</p>}
        </fieldset>
        <div className="lm-setting-row">
          <div>
            <div className="lm-setting-label">Notify me when it finishes</div>
            <div className="lm-setting-desc">Problems are always notified, even with this off.</div>
          </div>
          <Switch
            checked={form.notify}
            onCheckedChange={(v) => set('notify', v)}
            aria-label="Notify me when it finishes"
          />
        </div>
        <div className="lm-setting-row">
          <div className="lm-setting-label">Enabled</div>
          <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label="Enabled" />
        </div>
        {saveError && <Callout tone="danger">{saveError}</Callout>}
      </form>
    </Dialog>
  );
}
