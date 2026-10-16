import {
  Button,
  Callout,
  Dialog,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  StatusDot,
} from '@lumo/ui';
import {
  Download,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, type AttachmentInfo, type ConversationDetail } from '../lib/ipc';
import { navigate } from '../lib/router';
import type { RunLive, Segment } from '../lib/runState';
import { buildTranscript, planFor, segmentsFor, type Turn } from '../lib/transcript';
import { useApp } from '../state/app';
import { startedHere, useConversationRuns } from '../state/runs';
import { speech } from '../lib/speech';
import { SpeakingControl } from './SpeakingControl';
import { Composer, type ComposerHandle } from './Composer';
import { Markdown } from './Markdown';
import { Mascot } from './Mascot';
import { PreviewPane } from './PreviewPane';
import {
  ActivityList,
  ApprovalCard,
  OptionsCard,
  PlanPanel,
  QuestionCard,
  RunFooter,
  Working,
} from './RunParts';

/** What was just sent, shown until the stored conversation catches up. */
const spoken = new Set<string>();
const pendingSends = new Map<string, { text: string; attachments: AttachmentInfo[] }>();

/** Remember what was sent to start a new conversation, so it shows while the view loads. */
export function rememberPendingSend(conversationId: string, text: string, attachments: AttachmentInfo[]) {
  pendingSends.set(conversationId, { text, attachments });
}

export interface ConversationViewProps {
  conversationId: string;
  variant?: 'main' | 'compact' | 'panel';
  /** Called for open_preview events in panel mode (the project workspace shows its own preview). */
  onPreview?: (projectId: string, url: string) => void;
  /** Called when a tool finishes, e.g. so a project workspace can refresh its files. */
  onToolFinished?: () => void;
  composerRef?: React.Ref<ComposerHandle>;
}

export function ConversationView({
  conversationId,
  variant = 'main',
  onPreview,
  onToolFinished,
  composerRef,
}: ConversationViewProps) {
  const app = useApp();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const offsets = useRef(new Map<string, number>());
  const liveRuns = useConversationRuns(conversationId);
  const liveRef = useRef(liveRuns);
  liveRef.current = liveRuns;
  const [pending, setPending] = useState(() => pendingSends.get(conversationId) ?? null);

  const load = useCallback(async () => {
    try {
      const d = await api.getConversation(conversationId);
      const now = Date.now();
      for (const r of liveRef.current) offsets.current.set(r.runId, r.segments.length);
      setDetail(d);
      setLoadedAt(now);
      setLoadError(null);
      setPending(null);
      pendingSends.delete(conversationId);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [conversationId]);

  useEffect(() => {
    setDetail(null);
    setPending(pendingSends.get(conversationId) ?? null);
    void load();
  }, [conversationId, load]);

  // Reload when something was persisted (final answer stored, run finished) or a run we don't know starts.
  const persistKey = liveRuns.map((r) => `${r.runId}:${r.persistedVersion}`).join('|');
  const knownRuns = useMemo(() => new Set(detail?.runs.map((r) => r.id) ?? []), [detail]);
  const unknownRun = liveRuns.some((r) => !knownRuns.has(r.runId));
  useEffect(() => {
    if (detail && unknownRun) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknownRun]);
  useEffect(() => {
    if (detail && persistKey) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey]);

  // Tool results may change files the host shows.
  const toolKey = liveRuns
    .map(
      (r) =>
        r.segments.filter((s) => s.kind === 'tool' && s.state !== 'running' && s.state !== 'waiting').length,
    )
    .join(',');
  useEffect(() => {
    if (toolKey) onToolFinished?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolKey]);

  // Previews requested by the agent.
  const latestPreview =
    liveRuns
      .map((r) => r.preview)
      .filter(Boolean)
      .sort((a, b) => b!.at - a!.at)[0] ?? null;
  const [preview, setPreview] = useState<{ projectId: string; url: string; at: number } | null>(null);
  useEffect(() => {
    if (!latestPreview) return;
    if (onPreview) onPreview(latestPreview.projectId, latestPreview.url);
    else setPreview(latestPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestPreview?.at]);

  const turns = useMemo(() => (detail ? buildTranscript(detail) : []), [detail]);
  const liveById = useMemo(() => new Map(liveRuns.map((r) => [r.runId, r])), [liveRuns]);

  const activeLive = liveRuns.find((r) => r.status === 'running');
  const storedRunning = detail?.runs.find((r) => r.status === 'running' && !liveById.has(r.id));
  const runningId = activeLive?.runId ?? storedRunning?.id ?? null;
  const running = runningId !== null;

  // Runs that started but whose user message isn't in the loaded transcript yet.
  const orphanLive = liveRuns.filter((r) => !turns.some((t) => t.runId === r.runId));

  // Read finished replies aloud (only in the window that started the run).
  useEffect(() => {
    if (!app.settings.ttsEnabled) return;
    for (const r of liveRuns) {
      if (
        r.status !== 'done' ||
        !startedHere.has(r.runId) ||
        r.finishedAt === null ||
        r.finishedAt > loadedAt ||
        spoken.has(r.runId)
      )
        continue;
      spoken.add(r.runId);
      const turn = turns.find((t) => t.runId === r.runId);
      const text = turn ? [...turn.segments].reverse().find((s) => s.kind === 'text') : undefined;
      if (text && text.kind === 'text') speech.speak(text.text);
    }
  }, [app.settings.ttsEnabled, liveRuns, loadedAt, turns]);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const contentKey = `${turns.length}:${liveRuns.map((r) => r.segments.length + ':' + (r.segments.at(-1)?.kind === 'text' ? (r.segments.at(-1) as { text: string }).text.length : 0)).join(',')}:${pending ? 1 : 0}`;
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [contentKey]);

  const send = async (text: string, attachments: AttachmentInfo[]) => {
    setPending({ text, attachments });
    try {
      const started = await api.startRun({
        conversationId,
        text,
        attachments: attachments.map((a) => a.token),
      });
      startedHere.add(started.runId);
      stick.current = true;
      await load();
    } catch (e) {
      setPending(null);
      throw e;
    }
  };

  const stop = () => {
    if (runningId) void api.cancelRun(runningId).catch((e) => app.reportError(e, 'Couldn’t stop the task'));
  };

  const privacy =
    liveRuns
      .map((r) => r.privacy)
      .filter(Boolean)
      .sort((a, b) => b!.at - a!.at)[0] ?? null;

  const body = (
    <div
      className="lm-thread-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="lm-thread" data-variant={variant}>
        {loadError && (
          <Callout tone="danger" title="Couldn’t open this conversation">
            {loadError}
          </Callout>
        )}
        {!detail && !loadError && (
          <div className="lm-thread-loading">
            <Spinner label="Loading the conversation" />
          </div>
        )}
        {turns.map((t, i) => (
          <TurnView
            key={t.key}
            turn={t}
            live={t.runId ? liveById.get(t.runId) : undefined}
            loadedAt={loadedAt}
            offset={t.runId ? (offsets.current.get(t.runId) ?? 0) : 0}
            isLast={i === turns.length - 1}
            storedRunning={!!(t.run && t.run.status === 'running' && !liveById.has(t.run.id))}
          />
        ))}
        {pending && !turns.some((t) => t.userText.includes(pending.text)) && (
          <UserBubble
            text={pending.text ? [pending.text] : []}
            attachments={pending.attachments.map((a) => ({
              name: a.name,
              kind: a.kind === 'image' ? 'image' : 'file',
            }))}
          />
        )}
        {orphanLive.map((r) => (
          <LiveOnly key={r.runId} live={r} />
        ))}
      </div>
    </div>
  );

  const composer = (
    <div className="lm-thread-composer">
      <SpeakingControl />
      <Composer
        ref={composerRef}
        onSend={send}
        running={running}
        onStop={stop}
        acceptDrops={variant === 'main' || variant === 'panel'}
        size={variant === 'main' ? 'regular' : 'compact'}
        voiceShortcut={variant !== 'panel'}
        placeholder="Reply to Lumo…"
        autoFocus={variant !== 'panel'}
      />
    </div>
  );

  if (variant !== 'main') {
    return (
      <div className="lm-conversation" data-variant={variant}>
        {privacy && <PrivacyIndicator kind={privacy.kind} detail={privacy.detail} at={privacy.at} />}
        {body}
        {composer}
      </div>
    );
  }

  return (
    <div className="lm-conversation-split" data-preview={preview ? '' : undefined}>
      <div className="lm-conversation" data-variant="main">
        <ConversationHeader
          detail={detail}
          running={running}
          privacy={privacy}
          onRenamed={() => void load()}
          onShowPreview={
            detail?.conversation.projectId
              ? () =>
                  setPreview({ projectId: detail.conversation.projectId!, url: 'index.html', at: Date.now() })
              : undefined
          }
        />
        {body}
        {composer}
      </div>
      {preview && (
        <PreviewPane
          projectId={preview.projectId}
          path={preview.url}
          reloadKey={preview.at}
          onClose={() => setPreview(null)}
          showOpenProject
        />
      )}
    </div>
  );
}

function PrivacyIndicator({ kind, detail, at }: { kind: string; detail: string; at: number }) {
  const [visible, setVisible] = useState(Date.now() - at < 8000);
  useEffect(() => {
    setVisible(Date.now() - at < 8000);
    const t = setTimeout(() => setVisible(false), Math.max(0, 8000 - (Date.now() - at)));
    return () => clearTimeout(t);
  }, [at]);
  if (!visible) return null;
  return (
    <div className="lm-privacy" role="status" data-kind={kind}>
      <StatusDot tone="live" pulse />
      <span>{detail}</span>
    </div>
  );
}

function ConversationHeader({
  detail,
  running,
  privacy,
  onRenamed,
  onShowPreview,
}: {
  detail: ConversationDetail | null;
  running: boolean;
  privacy: { kind: string; detail: string; at: number } | null;
  onRenamed: () => void;
  onShowPreview?: () => void;
}) {
  const app = useApp();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const c = detail?.conversation;

  const rename = async () => {
    if (!c) return;
    try {
      await api.renameConversation(c.id, title);
      setRenaming(false);
      onRenamed();
      void app.reloadConversations();
    } catch (e) {
      app.reportError(e, 'Couldn’t rename');
    }
  };
  const exportIt = async () => {
    if (!c) return;
    try {
      await api.exportConversation(c.id);
    } catch (e) {
      app.reportError(e, 'Couldn’t export');
    }
  };
  const remove = async () => {
    if (!c) return;
    setBusy(true);
    try {
      await api.deleteConversation(c.id);
      setConfirmDelete(false);
      void app.reloadConversations();
      navigate({ name: 'home' });
    } catch (e) {
      app.reportError(e, 'Couldn’t delete');
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="lm-conv-header">
      <Mascot size="small" className="lm-conv-mascot" />
      {renaming ? (
        <form
          className="lm-rename"
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Conversation title"
            autoFocus
            onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
          />
          <Button size="sm" type="submit" variant="primary" disabled={!title.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <h1 className="lm-conv-title">{c?.title ?? ' '}</h1>
      )}
      <div className="lm-conv-header-end">
        {privacy && <PrivacyIndicator kind={privacy.kind} detail={privacy.detail} at={privacy.at} />}
        {running && (
          <span className="lm-conv-running">
            <StatusDot tone="accent" pulse />
            Working
          </span>
        )}
        {c?.projectId && (
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen />}
            onClick={() => navigate({ name: 'project', id: c.projectId! })}
          >
            Project
          </Button>
        )}
        {onShowPreview && (
          <Button size="sm" variant="ghost" onClick={onShowPreview}>
            Preview
          </Button>
        )}
        {c && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="Conversation options" icon={<MoreHorizontal />} size="sm" />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                icon={<Pencil />}
                onSelect={() => {
                  setTitle(c.title);
                  setRenaming(true);
                }}
              >
                Rename
              </MenuItem>
              <MenuItem icon={<Download />} onSelect={() => void exportIt()}>
                Export as Markdown
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 />}
                tone="danger"
                onSelect={() => setConfirmDelete(true)}
                disabled={running}
              >
                Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this conversation?"
        description="Its messages and task history are removed from this computer. Files Lumo changed are not affected."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      />
    </header>
  );
}

export function UserBubble({ text, attachments }: { text: string[]; attachments: Turn['attachments'] }) {
  return (
    <div className="lm-user">
      {attachments.length > 0 && (
        <ul className="lm-attachments lm-attachments-sent" aria-label="Attached">
          {attachments.map((a, i) => (
            <li key={i} className="lm-chip">
              {a.kind === 'image' ? <ImageIcon aria-hidden /> : <FileText aria-hidden />}
              <span className="lm-chip-name">{a.name}</span>
            </li>
          ))}
        </ul>
      )}
      {text.map((t, i) => (
        <p key={i} className="lm-user-text">
          {t}
        </p>
      ))}
    </div>
  );
}

/** Render a run's segments in order, grouping consecutive activity rows. */
export function SegmentList({
  segments,
  runId,
  live,
}: {
  segments: Segment[];
  runId: string | null;
  live: boolean;
}) {
  const out: ReactNode[] = [];
  let group: Extract<Segment, { kind: 'tool' | 'note' }>[] = [];
  const pendingApproval = [...segments]
    .reverse()
    .find((s) => s.kind === 'approval' && s.state === 'pending')?.id;
  const pendingQuestion = [...segments]
    .reverse()
    .find((s) => s.kind === 'question' && s.state === 'pending')?.id;
  const lastOptions = [...segments].reverse().find((s) => s.kind === 'options')?.id;
  const flush = (key: string) => {
    if (group.length) out.push(<ActivityList key={`g-${key}`} items={group} live={live} />);
    group = [];
  };
  for (const s of segments) {
    if (s.kind === 'tool' || s.kind === 'note') {
      group.push(s);
      continue;
    }
    flush(s.id);
    if (s.kind === 'text')
      out.push(<Markdown key={s.id} text={s.text} className={s.streaming ? 'lm-streaming' : undefined} />);
    else if (s.kind === 'approval')
      out.push(<ApprovalCard key={s.id} seg={s} runId={runId} target={s.id === pendingApproval} />);
    else if (s.kind === 'question')
      out.push(<QuestionCard key={s.id} seg={s} runId={runId} target={s.id === pendingQuestion} />);
    else if (s.kind === 'options')
      out.push(
        <OptionsCard key={s.id} title={s.title} items={s.items} target={live && s.id === lastOptions} />,
      );
  }
  flush('end');
  return <>{out}</>;
}

function RunBody({
  segments,
  live,
  runId,
  plan,
  status,
  error,
  summary,
  phase,
  storedRunning,
}: {
  segments: Segment[];
  live: RunLive | undefined;
  runId: string | null;
  plan: ReturnType<typeof planFor>;
  status: string | null;
  error: string | null;
  summary: string | null;
  phase: RunLive['phase'];
  storedRunning: boolean;
}) {
  const isRunning = status === 'running' || storedRunning;
  const last = segments[segments.length - 1];
  const showWorking =
    isRunning &&
    !(last && last.kind === 'text' && last.streaming) &&
    !(last && (last.kind === 'approval' || last.kind === 'question') && last.state === 'pending');
  return (
    <div className="lm-assistant">
      {plan && plan.length > 0 && <PlanPanel steps={plan} running={isRunning} />}
      <SegmentList segments={segments} runId={runId} live={!!live && live.status === 'running'} />
      {showWorking && <Working phase={phase} />}
      {runId && status && status !== 'running' && (
        <RunFooter runId={runId} status={status} error={error} summary={summary} />
      )}
    </div>
  );
}

function TurnView({
  turn,
  live,
  loadedAt,
  offset,
  storedRunning,
}: {
  turn: Turn;
  live: RunLive | undefined;
  loadedAt: number;
  offset: number;
  isLast: boolean;
  storedRunning: boolean;
}) {
  const segments = segmentsFor(turn, live, loadedAt, offset);
  const status = live ? live.status : (turn.run?.status ?? null);
  return (
    <Fragment>
      {(turn.userText.length > 0 || turn.attachments.length > 0) && (
        <UserBubble text={turn.userText} attachments={turn.attachments} />
      )}
      <RunBody
        segments={segments}
        live={live}
        runId={turn.runId}
        plan={planFor(turn, live)}
        status={status}
        error={live ? live.error : (turn.run?.error ?? null)}
        summary={live ? live.summary : (turn.run?.summary ?? null)}
        phase={live?.phase ?? null}
        storedRunning={storedRunning}
      />
    </Fragment>
  );
}

function LiveOnly({ live }: { live: RunLive }) {
  return (
    <RunBody
      segments={live.segments}
      live={live}
      runId={live.runId}
      plan={live.plan}
      status={live.status}
      error={live.error}
      summary={live.summary}
      phase={live.phase}
      storedRunning={false}
    />
  );
}
