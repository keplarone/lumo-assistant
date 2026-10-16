/**
 * Live runs in this window, keyed by run id, fed by the `agent-event` stream. Each window keeps its
 * own copy (the compact window and the main window both listen).
 */
import { useSyncExternalStore } from 'react';
import type { AgentEventEnvelope } from '../lib/ipc';
import { reduceRun, type RunLive } from '../lib/runState';

type Listener = () => void;

export class RunStore {
  private runs = new Map<string, RunLive>();
  private listeners = new Set<Listener>();
  private snapshot: ReadonlyMap<string, RunLive> = new Map();

  apply(env: AgentEventEnvelope) {
    this.runs.set(env.runId, reduceRun(this.runs.get(env.runId), env));
    this.emit();
  }

  update(runId: string, fn: (r: RunLive) => RunLive) {
    const r = this.runs.get(runId);
    if (!r) return;
    this.runs.set(runId, fn(r));
    this.emit();
  }

  get(runId: string) {
    return this.runs.get(runId);
  }

  /** The newest live run of a conversation. */
  forConversation(conversationId: string): RunLive[] {
    return [...this.runs.values()].filter((r) => r.conversationId === conversationId);
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = new Map(this.runs);
    for (const l of this.listeners) l();
  }
}

export const runStore = new RunStore();

export function useRuns(): ReadonlyMap<string, RunLive> {
  return useSyncExternalStore(runStore.subscribe, runStore.getSnapshot, runStore.getSnapshot);
}

export function useConversationRuns(conversationId: string | null | undefined): RunLive[] {
  const runs = useRuns();
  if (!conversationId) return [];
  return [...runs.values()].filter((r) => r.conversationId === conversationId);
}

/** Runs started from this window (used to decide which window reads a reply aloud). */
export const startedHere = new Set<string>();
