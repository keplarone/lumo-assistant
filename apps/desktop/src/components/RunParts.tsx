import { Badge, Button, Dialog, Input, Spinner, StatusDot } from '@lumo/ui';
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Clock,
  ExternalLink,
  Minus,
  MonitorCheck,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  api,
  errorMessage,
  type JournalEntry,
  type OptionItem,
  type PlanStep,
  type RunStatus,
  type UndoReport,
} from '../lib/ipc';
import { markAnswered, markApproval, PHASE_LABEL, runStatusInfo, type Segment } from '../lib/runState';
import { runStore } from '../state/runs';
import type { Phase } from '../lib/ipc';

type ApprovalSeg = Extract<Segment, { kind: 'approval' }>;
type QuestionSeg = Extract<Segment, { kind: 'question' }>;
type ToolSeg = Extract<Segment, { kind: 'tool' }>;

// ---- Approvals ----------------------------------------------------------------------------------

export function ApprovalCard({
  seg,
  runId,
  target,
}: {
  seg: ApprovalSeg;
  runId: string | null;
  target?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (a: 'once' | 'conversation' | 'deny') => {
    setBusy(a);
    setError(null);
    try {
      const ok = await api.resolveApproval(seg.id, a);
      // false: the request is gone (the task was stopped or it was answered elsewhere).
      if (!ok && runId) runStore.update(runId, (r) => markApproval(r, seg.id, 'expired'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const details = seg.preview.details.length > 0 && (
    <dl className="lm-approval-details">
      {seg.preview.details.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );

  if (seg.native) {
    return (
      <div
        className="lm-card lm-approval"
        data-state={seg.state}
        data-native=""
        data-lumo-target={target ? 'approval' : undefined}
      >
        <div className="lm-approval-head">
          <MonitorCheck aria-hidden className="lm-approval-icon" />
          <div>
            <div className="lm-approval-title">{seg.preview.title}</div>
            <div className="lm-approval-sub">
              {seg.state === 'pending'
                ? 'Confirm in the system dialog. Sensitive actions can only be approved there.'
                : seg.state === 'approved'
                  ? 'You allowed this in the system dialog.'
                  : seg.state === 'denied'
                    ? 'You declined this in the system dialog.'
                    : 'This request ended before it was answered.'}
            </div>
          </div>
        </div>
        {details}
        {seg.preview.warning && <p className="lm-approval-warning">{seg.preview.warning}</p>}
      </div>
    );
  }

  return (
    <section
      className="lm-card lm-approval"
      data-state={seg.state}
      aria-label={`Approval needed: ${seg.preview.title}`}
      data-lumo-target={target ? 'approval' : undefined}
    >
      <div className="lm-approval-head">
        <ShieldAlert aria-hidden className="lm-approval-icon" />
        <div>
          <div className="lm-approval-title">{seg.preview.title}</div>
          <div className="lm-approval-sub">
            {seg.state === 'pending'
              ? 'Lumo wants to make this change. Nothing happens until you choose.'
              : seg.state === 'approved'
                ? 'Allowed'
                : seg.state === 'denied'
                  ? 'Not allowed'
                  : 'This request ended before it was answered.'}
          </div>
        </div>
      </div>
      {details}
      {seg.preview.warning && <p className="lm-approval-warning">{seg.preview.warning}</p>}
      {seg.state === 'pending' && (
        <div className="lm-approval-actions">
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'once'}
            disabled={!!busy}
            onClick={() => void answer('once')}
            autoFocus={target}
          >
            Allow once
          </Button>
          {seg.tier === 'write' && (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'conversation'}
              disabled={!!busy}
              onClick={() => void answer('conversation')}
            >
              Allow for this conversation
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            loading={busy === 'deny'}
            disabled={!!busy}
            onClick={() => void answer('deny')}
          >
            Don’t allow
          </Button>
        </div>
      )}
      {error && (
        <p className="lm-inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ---- Questions ----------------------------------------------------------------------------------

export function QuestionCard({
  seg,
  runId,
  target,
}: {
  seg: QuestionSeg;
  runId: string | null;
  target?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (answer: string) => {
    const a = answer.trim();
    if (!a) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await api.answerQuestion(seg.id, a);
      if (runId)
        runStore.update(runId, (r) =>
          ok
            ? markAnswered(r, seg.id, a)
            : {
                ...r,
                segments: r.segments.map((x) =>
                  x.kind === 'question' && x.id === seg.id ? { ...x, state: 'expired' } : x,
                ),
              },
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="lm-card lm-question"
      data-state={seg.state}
      aria-label="Lumo has a question"
      data-lumo-target={target ? 'question' : undefined}
    >
      <p className="lm-question-text">{seg.question}</p>
      {seg.state === 'answered' && <p className="lm-question-answer">You answered: {seg.answer}</p>}
      {seg.state === 'expired' && <p className="lm-muted">This question was not answered.</p>}
      {seg.state === 'pending' && (
        <>
          {seg.options.length > 0 && (
            <div className="lm-question-options">
              {seg.options.map((o) => (
                <Button key={o} size="sm" variant="secondary" disabled={busy} onClick={() => void send(o)}>
                  {o}
                </Button>
              ))}
            </div>
          )}
          {seg.allowFreeText && (
            <form
              className="lm-question-free"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={seg.options.length ? 'Or type your own answer' : 'Type your answer'}
                aria-label="Your answer"
                autoFocus={target && seg.options.length === 0}
              />
              <Button type="submit" size="sm" variant="primary" disabled={!text.trim()} loading={busy}>
                Answer
              </Button>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="lm-inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ---- Options ------------------------------------------------------------------------------------

export function OptionsCard({
  title,
  items,
  target,
}: {
  title: string;
  items: OptionItem[];
  target?: boolean;
}) {
  return (
    <section className="lm-options" aria-label={title} data-lumo-target={target ? 'options' : undefined}>
      <h3 className="lm-options-title">{title}</h3>
      <div className="lm-options-grid">
        {items.map((it, i) => (
          <article key={i} className="lm-card lm-option">
            <div className="lm-option-head">
              <div className="lm-option-title">{it.title}</div>
              {it.price && <div className="lm-option-price">{it.price}</div>}
            </div>
            {it.subtitle && <div className="lm-option-sub">{it.subtitle}</div>}
            {it.details && it.details.length > 0 && (
              <ul className="lm-option-details">
                {it.details.map((d, j) => (
                  <li key={j}>{d}</li>
                ))}
              </ul>
            )}
            <div className="lm-option-foot">
              <span className="lm-option-source">Source: {it.source}</span>
              {it.url && /^https?:\/\//i.test(it.url) && (
                <a className="lm-link" href={it.url} target="_blank" rel="noreferrer">
                  Open site <ExternalLink aria-hidden />
                </a>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---- Tool activity ------------------------------------------------------------------------------

function ToolIcon({ state }: { state: ToolSeg['state'] }) {
  switch (state) {
    case 'running':
      return <Spinner size={14} />;
    case 'waiting':
      return <Clock aria-hidden />;
    case 'ok':
      return <Check aria-hidden />;
    case 'error':
      return <X aria-hidden />;
    case 'denied':
      return <Ban aria-hidden />;
    case 'cancelled':
      return <Minus aria-hidden />;
  }
}

const STATE_TEXT: Record<ToolSeg['state'], string> = {
  running: 'In progress',
  waiting: 'Waiting for you',
  ok: 'Done',
  error: 'Failed',
  denied: 'Not allowed',
  cancelled: 'Stopped',
};

function resultUrl(data: unknown): string | null {
  if (data && typeof data === 'object' && 'url' in data) {
    const u = (data as { url: unknown }).url;
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
  }
  return null;
}

const LINK_TOOLS = new Set(['deploy_to_netlify', 'publish_to_github', 'prepare_checkout_handoff']);

export function ActivityList({
  items,
  live,
}: {
  items: (ToolSeg | Extract<Segment, { kind: 'note' }>)[];
  live: boolean;
}) {
  const anyRunning = items.some((i) => i.kind === 'tool' && (i.state === 'running' || i.state === 'waiting'));
  const tools = items.filter((i) => i.kind === 'tool').length;
  const collapsible = !live && !anyRunning && items.length > 3;
  const [open, setOpen] = useState(false);
  const shown = collapsible && !open ? [] : items;
  return (
    <div className="lm-activity">
      {collapsible && (
        <button
          type="button"
          className="lm-activity-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          {tools} {tools === 1 ? 'step' : 'steps'}
          {summaryCounts(items)}
        </button>
      )}
      {shown.length > 0 && (
        <ol className="lm-activity-list">
          {shown.map((i) =>
            i.kind === 'note' ? (
              <li key={i.id} className="lm-activity-row" data-kind="note">
                <CircleDashed aria-hidden />
                <span>{i.text}</span>
              </li>
            ) : (
              <li key={i.id} className="lm-activity-row" data-state={i.state}>
                <span className="lm-activity-icon" aria-label={STATE_TEXT[i.state]} role="img">
                  <ToolIcon state={i.state} />
                </span>
                <span className="lm-activity-text">
                  {i.state === 'running' || i.state === 'waiting' || !i.summary ? i.label : i.summary}
                </span>
                {i.approval === 'denied' && i.state !== 'denied' && <Badge tone="warning">Not allowed</Badge>}
                {LINK_TOOLS.has(i.name) && resultUrl(i.data) && (
                  <a className="lm-link" href={resultUrl(i.data)!} target="_blank" rel="noreferrer">
                    {hostLabel(resultUrl(i.data)!)} <ExternalLink aria-hidden />
                  </a>
                )}
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function summaryCounts(items: (ToolSeg | Extract<Segment, { kind: 'note' }>)[]) {
  const failed = items.filter(
    (i) => i.kind === 'tool' && (i.state === 'error' || i.state === 'denied'),
  ).length;
  return failed ? <span className="lm-activity-failed"> · {failed} didn’t work</span> : null;
}

function hostLabel(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return 'Open';
  }
}

// ---- Plan ---------------------------------------------------------------------------------------

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case 'done':
      return <Check aria-hidden />;
    case 'active':
      return <Spinner size={13} />;
    case 'failed':
      return <X aria-hidden />;
    case 'skipped':
      return <Minus aria-hidden />;
    default:
      return <Circle aria-hidden />;
  }
}

export function PlanPanel({ steps, running }: { steps: PlanStep[]; running: boolean }) {
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <section className="lm-plan" aria-label="Plan">
      <div className="lm-plan-head">
        <span>Plan</span>
        <span className="lm-plan-count">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="lm-plan-steps">
        {steps.map((s, i) => (
          <li key={i} data-status={running || s.status !== 'active' ? s.status : 'pending'}>
            <span className="lm-plan-icon">
              <StepIcon status={running || s.status !== 'active' ? s.status : 'pending'} />
            </span>
            <span>{s.title}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- Run status ---------------------------------------------------------------------------------

export function Working({ phase }: { phase: Phase | null }) {
  return (
    <div className="lm-working" role="status">
      <Spinner size={14} />
      <span>{phase ? PHASE_LABEL[phase] : 'Starting'}…</span>
    </div>
  );
}

export function RunFooter({
  runId,
  status,
  error,
  summary,
}: {
  runId: string;
  status: RunStatus;
  error: string | null;
  summary: string | null;
}) {
  const [changes, setChanges] = useState<JournalEntry[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<UndoReport | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'running') return;
    let live = true;
    api
      .listChanges(runId, 500)
      .then((c) => live && setChanges(c.filter((x) => !x.undone)))
      .catch(() => live && setChanges([]));
    return () => {
      live = false;
    };
  }, [runId, status, report]);

  const info = runStatusInfo(status);
  const undo = async () => {
    setBusy(true);
    setUndoError(null);
    try {
      setReport(await api.undoRun(runId));
      setConfirm(false);
    } catch (e) {
      setUndoError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const showStatus = status !== 'done' || (changes && changes.length > 0) || report;
  if (!showStatus) return null;

  const message =
    status === 'failed' || status === 'refused'
      ? error
      : status === 'needs_attention'
        ? 'It stopped at a step that needs your approval.'
        : status === 'stopped' || status === 'interrupted'
          ? (summary ?? error)
          : null;

  return (
    <div className="lm-run-footer" data-tone={info.tone}>
      {status !== 'done' && (
        <div className="lm-run-status">
          <StatusDot tone={info.tone === 'neutral' ? 'neutral' : info.tone} />
          <span className="lm-run-status-label">{info.label}</span>
          {message && <span className="lm-run-status-msg">{message}</span>}
        </div>
      )}
      {changes && changes.length > 0 && (
        <div className="lm-run-undo">
          <span className="lm-muted">
            Changed {changes.length} {changes.length === 1 ? 'item' : 'items'} on your computer.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Undo changes
          </Button>
        </div>
      )}
      {report && (
        <div className="lm-run-undo-report" role="status">
          <span>
            Undid {report.undone} {report.undone === 1 ? 'change' : 'changes'}.
          </span>
          {report.skipped.length > 0 && (
            <>
              <span> These couldn’t be undone safely:</span>
              <ul>
                {report.skipped.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Undo this task’s changes?"
        description="Lumo reverses its changes newest first. Anything that changed since is left alone and listed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void undo()}>
              Undo {changes?.length ?? 0} {changes?.length === 1 ? 'change' : 'changes'}
            </Button>
          </>
        }
      >
        <ul className="lm-change-list">
          {changes?.slice(0, 50).map((c) => (
            <li key={c.id}>
              <span className="lm-change-op">{opLabel(c.op)}</span>
              <span className="lm-change-path">{c.destPath ? `${c.path} → ${c.destPath}` : c.path}</span>
            </li>
          ))}
        </ul>
        {undoError && (
          <p className="lm-inline-error" role="alert">
            {undoError}
          </p>
        )}
      </Dialog>
    </div>
  );
}

function opLabel(op: string) {
  switch (op) {
    case 'create_file':
      return 'Created';
    case 'overwrite_file':
      return 'Changed';
    case 'create_folder':
      return 'New folder';
    case 'move':
      return 'Moved';
    case 'trash':
      return 'Trashed';
    default:
      return op;
  }
}
