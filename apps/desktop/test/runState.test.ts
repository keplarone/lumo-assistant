import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '../src/lib/ipc';
import { mascotEventsFor } from '../src/lib/mascotEvents';
import { pendingInteractions, reduceRun, type RunLive } from '../src/lib/runState';

const env = (event: AgentEvent): AgentEventEnvelope => ({ runId: 'r1', conversationId: 'c1', event });
const play = (events: AgentEvent[]): RunLive =>
  events.reduce<RunLive | undefined>((s, e) => reduceRun(s, env(e), 1000), undefined)!;

describe('reduceRun', () => {
  it('streams text into one segment and closes it when a tool starts', () => {
    const s = play([
      { type: 'run_started', runId: 'r1', conversationId: 'c1' },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      {
        type: 'tool_started',
        callId: 't1',
        name: 'list_files',
        label: 'Looking in Downloads',
        risk: 'read',
        input: {},
      },
    ]);
    expect(s.started).toBe(true);
    expect(s.segments).toHaveLength(2);
    expect(s.segments[0]).toMatchObject({ kind: 'text', text: 'Hello', streaming: false });
    expect(s.segments[1]).toMatchObject({
      kind: 'tool',
      id: 't1',
      state: 'running',
      label: 'Looking in Downloads',
    });
  });

  it('does not show UI tools as activity rows', () => {
    const s = play([
      { type: 'tool_started', callId: 'p', name: 'update_plan', label: 'Planning', risk: 'read', input: {} },
    ]);
    expect(s.segments).toHaveLength(0);
    expect(s.tools.p?.label).toBe('Planning');
  });

  it('tracks approvals: waiting tool, resolved, then finished', () => {
    const preview = {
      title: 'Move 3 files',
      details: [['To', '~/Documents']] as [string, string][],
      warning: null,
    };
    let s = play([
      {
        type: 'tool_started',
        callId: 't1',
        name: 'move_files',
        label: 'Moving files',
        risk: 'write',
        input: {},
      },
      { type: 'approval_requested', approvalId: 'a1', callId: 't1', tier: 'write', native: false, preview },
    ]);
    expect(s.segments[0]).toMatchObject({ kind: 'tool', state: 'waiting' });
    expect(s.segments[1]).toMatchObject({ kind: 'approval', id: 'a1', state: 'pending' });
    expect(pendingInteractions(s)).toBe(1);
    s = reduceRun(s, env({ type: 'approval_resolved', approvalId: 'a1', approved: true }));
    expect(s.segments[0]).toMatchObject({ state: 'running', approval: 'approved' });
    expect(s.segments[1]).toMatchObject({ state: 'approved' });
    s = reduceRun(
      s,
      env({
        type: 'tool_finished',
        callId: 't1',
        name: 'move_files',
        ok: true,
        summary: 'Moved 3 files',
        data: null,
      }),
    );
    expect(s.segments[0]).toMatchObject({ state: 'ok', summary: 'Moved 3 files' });
  });

  it('marks a declined tool as denied rather than failed', () => {
    const preview = { title: 'Delete', details: [], warning: null };
    const s = play([
      { type: 'tool_started', callId: 't1', name: 'move_to_trash', label: 'Trash', risk: 'write', input: {} },
      { type: 'approval_requested', approvalId: 'a1', callId: 't1', tier: 'write', native: false, preview },
      { type: 'approval_resolved', approvalId: 'a1', approved: false },
      {
        type: 'tool_finished',
        callId: 't1',
        name: 'move_to_trash',
        ok: false,
        summary: 'Declined',
        data: null,
      },
    ]);
    expect(s.segments[0]).toMatchObject({ state: 'denied' });
  });

  it('expires pending questions and cancels running tools when a run is stopped', () => {
    const s = play([
      { type: 'tool_started', callId: 't1', name: 'read_file', label: 'Reading', risk: 'read', input: {} },
      {
        type: 'question',
        questionId: 'q1',
        question: 'Which folder?',
        options: ['A', 'B'],
        allowFreeText: false,
      },
      { type: 'run_finished', runId: 'r1', status: 'cancelled', summary: null, error: null },
    ]);
    expect(s.segments.find((x) => x.kind === 'question')).toMatchObject({ state: 'expired' });
    expect(s.segments.find((x) => x.kind === 'tool')).toMatchObject({ state: 'cancelled' });
    expect(s.status).toBe('cancelled');
    expect(s.finishedAt).toBe(1000);
    expect(s.persistedVersion).toBe(1);
  });

  it('records privacy notes, including input control', () => {
    const s = play([{ type: 'privacy', kind: 'input_control', detail: 'Using your mouse and keyboard' }]);
    expect(s.privacy).toEqual({ kind: 'input_control', detail: 'Using your mouse and keyboard', at: 1000 });
  });

  it('ignores duplicate progress notes', () => {
    const s = play([
      { type: 'progress_note', text: 'Checking' },
      { type: 'progress_note', text: 'Checking' },
    ]);
    expect(s.segments).toHaveLength(1);
  });
});

describe('mood', () => {
  it('never becomes a timeline step', () => {
    const s = play([
      {
        type: 'tool_started',
        callId: 'm',
        name: 'set_mood',
        label: 'Feeling warm',
        risk: 'ui',
        input: { mood: 'warm' },
      },
      { type: 'mood', mood: 'warm' },
    ]);
    expect(s.segments).toHaveLength(0);
  });
  it('maps to the closest mascot expression', () => {
    expect(mascotEventsFor({ type: 'mood', mood: 'happy' })).toEqual([{ type: 'agent', phase: 'done' }]);
    expect(mascotEventsFor({ type: 'mood', mood: 'celebrating' })).toEqual([
      { type: 'agent', phase: 'done' },
    ]);
    expect(mascotEventsFor({ type: 'mood', mood: 'concerned' })).toEqual([
      { type: 'agent', phase: 'uncertain' },
    ]);
    expect(mascotEventsFor({ type: 'mood', mood: 'calm' })).toEqual([{ type: 'agent', phase: 'idle' }]);
    expect(
      mascotEventsFor({
        type: 'tool_started',
        callId: 'm',
        name: 'set_mood',
        label: '',
        risk: 'ui',
        input: {},
      }),
    ).toEqual([]);
  });
});
