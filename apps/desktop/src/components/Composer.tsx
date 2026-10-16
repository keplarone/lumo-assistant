import { Button, IconButton, Select, Spinner, StatusDot, Textarea } from '@lumo/ui';
import { ArrowUp, FileText, Image as ImageIcon, Mic, Paperclip, Square, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, errorMessage, on, type AgentDef, type AttachmentInfo } from '../lib/ipc';
import { formatBytes } from '../lib/format';
import { formatElapsed } from '../lib/voice';
import { useApp } from '../state/app';
import { mascotBus, useListening } from '../state/mascot';
import { useVoice } from '../state/useVoice';

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
  attach(): Promise<void>;
}

export interface ComposerProps {
  /** Throw to keep the draft (the error is shown under the composer). */
  onSend: (text: string, attachments: AttachmentInfo[], agentId: string | null) => Promise<void>;
  running: boolean;
  onStop?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Custom agents to choose from (only when starting a new conversation). */
  agents?: AgentDef[];
  /** Take files dropped on the window (main window only). */
  acceptDrops?: boolean;
  disabledReason?: string | null;
  size?: 'regular' | 'compact';
  /** Hold Ctrl/Cmd+Shift+Space to talk while this window is focused. */
  voiceShortcut?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    onSend,
    running,
    onStop,
    placeholder = 'Tell Lumo what you want…',
    autoFocus,
    agents = [],
    acceptDrops,
    disabledReason,
    size = 'regular',
    voiceShortcut = true,
  },
  ref,
) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const app = useApp();
  const voice = useVoice((t) => {
    setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')} ${t}` : t));
    requestAnimationFrame(() => area.current?.focus());
  });
  const pressAt = useRef(0);
  const ignoreUp = useRef(false);
  const recording = voice.status === 'recording' || voice.status === 'starting';
  useListening(focused || text.length > 0 || recording, running);

  useEffect(() => {
    if (voice.status === 'recording')
      app.announce(
        voice.mode === 'handsfree' ? 'Recording. Lumo stops when you pause.' : 'Recording while you hold.',
      );
    if (voice.status === 'transcribing') app.announce('Transcribing your recording.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.status]);

  // Push-to-talk shortcut: hold Ctrl/Cmd+Shift+Space.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  useEffect(() => {
    if (!voiceShortcut) return;
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.repeat) {
        e.preventDefault();
        if (voiceRef.current.status === 'idle') void voiceRef.current.start('hold');
      }
    };
    const up = (e: KeyboardEvent) => {
      if (
        (e.code === 'Space' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') &&
        voiceRef.current.mode === 'hold'
      )
        voiceRef.current.stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [voiceShortcut]);

  const attach = async () => {
    setError(null);
    try {
      const picked = await api.attachFiles();
      if (picked.length) setAttachments((xs) => dedupe([...xs, ...picked]));
      area.current?.focus();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = area.current;
        if (el) {
          el.focus();
          el.setSelectionRange(t.length, t.length);
        }
      });
    },
    attach,
  }));

  useEffect(() => {
    if (!acceptDrops) return;
    const sub = on('files-dropped', (files) => {
      if (!files?.length) return;
      setAttachments((xs) => dedupe([...xs, ...files]));
      mascotBus.send({ type: 'activity' });
      area.current?.focus();
    });
    return () => void sub.then((u) => u());
  }, [acceptDrops]);

  const canSend =
    !running && !sending && !disabledReason && (text.trim().length > 0 || attachments.length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim(), attachments, agentId || null);
      setText('');
      setAttachments([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const showAgents = agents.length > 0;

  return (
    <div className="lm-composer" data-size={size} data-lumo-target="composer">
      <div className="lm-composer-box" data-focused={focused || undefined}>
        {attachments.length > 0 && (
          <ul className="lm-attachments" aria-label="Attachments">
            {attachments.map((a) => (
              <li key={a.token} className="lm-chip">
                {a.kind === 'image' ? <ImageIcon aria-hidden /> : <FileText aria-hidden />}
                <span className="lm-chip-name">{a.name}</span>
                <span className="lm-chip-meta">{formatBytes(a.bytes)}</span>
                <button
                  type="button"
                  className="lm-chip-remove"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((xs) => xs.filter((x) => x.token !== a.token))}
                >
                  <X aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          ref={area}
          className="lm-composer-input"
          autoSize
          maxRows={size === 'compact' ? 6 : 10}
          rows={1}
          value={text}
          placeholder={disabledReason ?? placeholder}
          aria-label="Message to Lumo"
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            mascotBus.send({ type: 'activity' });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="lm-composer-bar">
          <IconButton
            label="Attach files"
            icon={<Paperclip />}
            size="sm"
            onClick={() => void attach()}
            disabled={running}
          />
          {showAgents && (
            <Select
              className="lm-agent-select"
              aria-label="Assistant"
              value={agentId || 'default'}
              onValueChange={(v) => setAgentId(v === 'default' ? '' : v)}
              options={[
                { value: 'default', label: 'Lumo' },
                ...agents.map((a) => ({ value: a.id ?? '', label: a.name })),
              ]}
            />
          )}
          {voice.supported && (
            <IconButton
              label={recording ? 'Stop recording' : 'Talk to Lumo (click for hands-free, or hold to talk)'}
              icon={<Mic />}
              size="sm"
              data-recording={recording || undefined}
              aria-pressed={recording}
              disabled={voice.status === 'transcribing'}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                pressAt.current = performance.now();
                if (recording) {
                  ignoreUp.current = true;
                  voice.stop();
                } else {
                  ignoreUp.current = false;
                  void voice.start('hold');
                }
              }}
              onPointerUp={() => {
                if (ignoreUp.current) return;
                if (performance.now() - pressAt.current < 300) voice.setMode('handsfree');
                else voice.stop();
              }}
              onClick={(e) => {
                // Keyboard activation (Enter/Space) toggles hands-free recording.
                if (e.detail !== 0) return;
                if (recording) voice.stop();
                else void voice.start('handsfree');
              }}
            />
          )}
          {recording ? (
            <span className="lm-recording" role="status">
              <StatusDot tone="live" pulse />
              <span className="lm-recording-time">{formatElapsed(voice.elapsed)}</span>
              <span className="lm-recording-level" aria-hidden>
                <span style={{ transform: `scaleX(${Math.max(0.04, voice.level)})` }} />
              </span>
              <span>{voice.mode === 'handsfree' ? 'Listening, stops when you pause' : 'Listening'}</span>
              <Button size="sm" variant="ghost" onClick={() => voice.stop()}>
                Stop
              </Button>
              <IconButton
                label="Discard recording"
                icon={<X />}
                size="sm"
                onClick={() => voice.cancel()}
                noTooltip
              />
            </span>
          ) : voice.status === 'transcribing' ? (
            <span className="lm-recording" role="status">
              <Spinner size={14} />
              <span>Transcribing…</span>
            </span>
          ) : (
            <span className="lm-composer-hint" aria-hidden>
              {running ? 'Lumo is working' : 'Enter to send · Shift+Enter for a new line'}
            </span>
          )}
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Square />}
              onClick={onStop}
              aria-label="Stop the task"
            >
              Stop
            </Button>
          ) : (
            <IconButton
              label="Send"
              variant="primary"
              size="sm"
              icon={<ArrowUp />}
              onClick={() => void send()}
              disabled={!canSend}
              loading={sending}
              noTooltip
            />
          )}
        </div>
      </div>
      {(error || voice.error) && (
        <p className="lm-composer-error" role="alert">
          {error ?? voice.error}
        </p>
      )}
    </div>
  );
});

function dedupe(xs: AttachmentInfo[]) {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.token) ? false : (seen.add(x.token), true)));
}
