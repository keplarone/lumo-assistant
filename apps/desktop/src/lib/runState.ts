/**
 * Live run state, built only from AgentEvents. Pure functions so they are unit tested.
 *
 * A run's visible content is an ordered list of segments: streamed text, tool activity, progress
 * notes and interactive cards (approvals, questions, options), in the order they happened.
 */
import type { ActionPreview, AgentEventEnvelope, OptionItem, Phase, PlanStep, RunStatus } from './ipc';

export type ToolState = 'running' | 'waiting' | 'ok' | 'error' | 'denied' | 'cancelled';

export type Segment =
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  | { kind: 'note'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      label: string;
      risk: string;
      state: ToolState;
      summary: string | null;
      approval: string | null;
      data: unknown;
    }
  | {
      kind: 'approval';
      id: string;
      callId: string;
      tier: string;
      native: boolean;
      preview: ActionPreview;
      state: 'pending' | 'approved' | 'denied' | 'expired';
    }
  | {
      kind: 'question';
      id: string;
      question: string;
      options: string[];
      allowFreeText: boolean;
      state: 'pending' | 'answered' | 'expired';
      answer: string | null;
    }
  | { kind: 'options'; id: string; title: string; items: OptionItem[] };

export interface RunLive {
  runId: string;
  conversationId: string;
  /** Saw run_started, so `segments` covers the whole run. */
  started: boolean;
  status: RunStatus;
  phase: Phase | null;
  segments: Segment[];
  plan: PlanStep[] | null;
  summary: string | null;
  error: string | null;
  privacy: { kind: string; detail: string; at: number } | null;
  preview: { projectId: string; url: string; at: number } | null;
  /** Labels and structured results by tool call id, to enrich the persisted transcript. */
  tools: Record<string, { label: string; data: unknown }>;
  finishedAt: number | null;
  /** Bumped whenever something persisted changed (an assistant message was stored or the run ended). */
  persistedVersion: number;
}

/** Tools whose only effect is a card in the conversation; they are not shown as activity rows. */
export const UI_TOOLS = new Set(['update_plan', 'ask_user', 'present_options', 'set_mood']);

export function newRun(runId: string, conversationId: string): RunLive {
  return {
    runId,
    conversationId,
    started: false,
    status: 'running',
    phase: null,
    segments: [],
    plan: null,
    summary: null,
    error: null,
    privacy: null,
    preview: null,
    tools: {},
    finishedAt: null,
    persistedVersion: 0,
  };
}

function endStreaming(segments: Segment[]): Segment[] {
  const last = segments[segments.length - 1];
  if (last && last.kind === 'text' && last.streaming)
    return [...segments.slice(0, -1), { ...last, streaming: false }];
  return segments;
}

function updateTool(
  segments: Segment[],
  callId: string,
  patch: (s: Extract<Segment, { kind: 'tool' }>) => Segment,
): Segment[] {
  let found = false;
  const next = segments.map((s) => {
    if (s.kind === 'tool' && s.id === callId) {
      found = true;
      return patch(s);
    }
    return s;
  });
  return found ? next : segments;
}

let seq = 0;
const localId = (p: string) => `${p}-${++seq}`;

/** Apply one event. `now` is injected for tests. */
export function reduceRun(
  prev: RunLive | undefined,
  env: AgentEventEnvelope,
  now: number = Date.now(),
): RunLive {
  const s: RunLive = prev ?? newRun(env.runId, env.conversationId);
  const ev = env.event;
  switch (ev.type) {
    case 'run_started':
      return { ...s, started: true, status: 'running' };
    case 'phase':
      return { ...s, phase: ev.phase };
    case 'text_delta': {
      const last = s.segments[s.segments.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        return { ...s, segments: [...s.segments.slice(0, -1), { ...last, text: last.text + ev.text }] };
      }
      return {
        ...s,
        segments: [...s.segments, { kind: 'text', id: localId('text'), text: ev.text, streaming: true }],
      };
    }
    case 'progress_note': {
      const text = ev.text.trim();
      if (!text) return s;
      const last = s.segments[s.segments.length - 1];
      if (last && last.kind === 'note' && last.text === text) return s;
      return { ...s, segments: [...endStreaming(s.segments), { kind: 'note', id: localId('note'), text }] };
    }
    case 'plan':
      return { ...s, plan: ev.steps };
    case 'tool_started': {
      const tools = { ...s.tools, [ev.callId]: { label: ev.label, data: s.tools[ev.callId]?.data ?? null } };
      if (UI_TOOLS.has(ev.name)) return { ...s, tools, segments: endStreaming(s.segments) };
      if (s.segments.some((x) => x.kind === 'tool' && x.id === ev.callId)) return { ...s, tools };
      return {
        ...s,
        tools,
        segments: [
          ...endStreaming(s.segments),
          {
            kind: 'tool',
            id: ev.callId,
            name: ev.name,
            label: ev.label,
            risk: ev.risk,
            state: 'running',
            summary: null,
            approval: null,
            data: null,
          },
        ],
      };
    }
    case 'tool_finished': {
      const tools = {
        ...s.tools,
        [ev.callId]: { label: s.tools[ev.callId]?.label ?? ev.name, data: ev.data ?? null },
      };
      const declined = s.segments.some(
        (x) => x.kind === 'approval' && x.callId === ev.callId && x.state === 'denied',
      );
      const state: ToolState = ev.ok ? 'ok' : declined ? 'denied' : 'error';
      return {
        ...s,
        tools,
        segments: updateTool(s.segments, ev.callId, (t) => ({
          ...t,
          state,
          summary: ev.summary || null,
          data: ev.data ?? null,
        })),
      };
    }
    case 'approval_requested': {
      if (s.segments.some((x) => x.kind === 'approval' && x.id === ev.approvalId)) return s;
      const segments = updateTool(s.segments, ev.callId, (t) => ({ ...t, state: 'waiting' }));
      return {
        ...s,
        segments: [
          ...endStreaming(segments),
          {
            kind: 'approval',
            id: ev.approvalId,
            callId: ev.callId,
            tier: ev.tier,
            native: ev.native,
            preview: ev.preview,
            state: 'pending',
          },
        ],
      };
    }
    case 'approval_resolved': {
      let callId: string | null = null;
      const segments = s.segments.map((x) => {
        if (x.kind === 'approval' && x.id === ev.approvalId) {
          callId = x.callId;
          return { ...x, state: ev.approved ? ('approved' as const) : ('denied' as const) };
        }
        return x;
      });
      const withTool = callId
        ? updateTool(segments, callId, (t) => ({
            ...t,
            state: ev.approved ? 'running' : 'denied',
            approval: ev.approved ? 'approved' : 'denied',
          }))
        : segments;
      return { ...s, segments: withTool };
    }
    case 'question':
      if (s.segments.some((x) => x.kind === 'question' && x.id === ev.questionId)) return s;
      return {
        ...s,
        segments: [
          ...endStreaming(s.segments),
          {
            kind: 'question',
            id: ev.questionId,
            question: ev.question,
            options: ev.options,
            allowFreeText: ev.allowFreeText,
            state: 'pending',
            answer: null,
          },
        ],
      };
    case 'options':
      return {
        ...s,
        segments: [
          ...endStreaming(s.segments),
          {
            kind: 'options',
            id: localId('options'),
            title: ev.title,
            items: Array.isArray(ev.items) ? ev.items : [],
          },
        ],
      };
    case 'open_preview':
      return { ...s, preview: { projectId: ev.projectId, url: ev.url, at: now } };
    case 'mood':
      // Only the mascot reacts (mascotEventsFor); nothing is added to the conversation.
      return s;
    case 'privacy':
      return { ...s, privacy: { kind: ev.kind, detail: ev.detail, at: now } };
    case 'assistant_message':
      return { ...s, segments: endStreaming(s.segments), persistedVersion: s.persistedVersion + 1 };
    case 'run_finished': {
      const ended = ev.status !== 'done';
      const segments = endStreaming(s.segments).map((x): Segment => {
        if (x.kind === 'approval' && x.state === 'pending') return { ...x, state: 'expired' };
        if (x.kind === 'question' && x.state === 'pending') return { ...x, state: 'expired' };
        if (x.kind === 'tool' && (x.state === 'running' || x.state === 'waiting') && ended)
          return { ...x, state: 'cancelled' };
        return x;
      });
      return {
        ...s,
        segments,
        status: ev.status,
        summary: ev.summary,
        error: ev.error,
        phase: null,
        finishedAt: now,
        persistedVersion: s.persistedVersion + 1,
      };
    }
  }
}

/** Mark a question answered locally (Rust does not echo answers as an event). */
export function markAnswered(s: RunLive, questionId: string, answer: string): RunLive {
  return {
    ...s,
    segments: s.segments.map((x) =>
      x.kind === 'question' && x.id === questionId ? { ...x, state: 'answered', answer } : x,
    ),
  };
}

/** Mark an approval as no longer pending in this window (e.g. it was already resolved elsewhere). */
export function markApproval(
  s: RunLive,
  approvalId: string,
  state: 'approved' | 'denied' | 'expired',
): RunLive {
  return {
    ...s,
    segments: s.segments.map((x) => (x.kind === 'approval' && x.id === approvalId ? { ...x, state } : x)),
  };
}

export function pendingInteractions(s: RunLive | undefined): number {
  if (!s) return 0;
  return s.segments.filter(
    (x) =>
      (x.kind === 'approval' && x.state === 'pending' && !x.native) ||
      (x.kind === 'question' && x.state === 'pending'),
  ).length;
}

export const PHASE_LABEL: Record<Phase, string> = {
  understanding: 'Understanding',
  planning: 'Planning',
  executing: 'Working',
  verifying: 'Checking the result',
  reporting: 'Writing the answer',
};

export interface StatusInfo {
  label: string;
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

export function runStatusInfo(status: RunStatus): StatusInfo {
  switch (status) {
    case 'running':
      return { label: 'Working', tone: 'accent' };
    case 'done':
      return { label: 'Done', tone: 'success' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    case 'cancelled':
      return { label: 'Stopped', tone: 'neutral' };
    case 'refused':
      return { label: 'Declined by the model', tone: 'warning' };
    case 'stopped':
      return { label: 'Stopped at a limit', tone: 'warning' };
    case 'needs_attention':
      return { label: 'Needs your attention', tone: 'warning' };
    case 'interrupted':
      return { label: 'Interrupted', tone: 'warning' };
    case 'limit_reached':
      return { label: 'Plan limit reached', tone: 'warning' };
    default:
      return { label: status, tone: 'neutral' };
  }
}
