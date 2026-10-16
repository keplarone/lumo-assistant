/**
 * Rebuild what the user saw from the persisted conversation (get_conversation): messages, runs and
 * tool calls. Machine context (the <context> and <memory> blocks Lumo adds to each turn), tool
 * results and thinking are never shown.
 */
import type {
  ContentBlock,
  ConversationDetail,
  OptionItem,
  PlanStep,
  RunRecord,
  StoredMessage,
  ToolCallRecord,
} from './ipc';
import { type RunLive, type Segment, type ToolState, UI_TOOLS } from './runState';

export interface UserAttachment {
  name: string;
  kind: 'image' | 'pdf' | 'file';
}

export interface Turn {
  key: string;
  runId: string | null;
  run: RunRecord | null;
  userText: string[];
  attachments: UserAttachment[];
  segments: Segment[];
  createdAt: string;
}

/** True for blocks Lumo adds for the model, not written by the user. */
export function isMachineContext(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<context>') || t.startsWith('<memory>');
}

const ATTACHED = /^The user attached (.+?) \(/;

/** The parts of a user message the user actually wrote or attached. */
export function visibleUserContent(content: ContentBlock[]): {
  text: string[];
  attachments: UserAttachment[];
} {
  const text: string[] = [];
  const attachments: UserAttachment[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      if (isMachineContext(b.text)) continue;
      const m = ATTACHED.exec(b.text);
      if (m && b.text.includes('<untrusted_content>')) {
        attachments.push({ name: m[1]!, kind: 'file' });
        continue;
      }
      if (b.text.trim()) text.push(b.text);
    } else if (b.type === 'image') {
      attachments.push({ name: 'Image', kind: 'image' });
    } else if (b.type === 'document') {
      attachments.push({ name: typeof b.title === 'string' ? b.title : 'Document', kind: 'pdf' });
    }
  }
  return { text, attachments };
}

function resultText(block: ContentBlock | undefined): string {
  if (!block) return '';
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x) =>
        x && typeof x === 'object' && (x as ContentBlock).type === 'text'
          ? String((x as ContentBlock).text ?? '')
          : '',
      )
      .join('\n');
  }
  return '';
}

function toolState(tc: ToolCallRecord | undefined, result: ContentBlock | undefined): ToolState {
  if (tc) {
    switch (tc.status) {
      case 'ok':
        return 'ok';
      case 'denied':
        return 'denied';
      case 'cancelled':
        return 'cancelled';
      case 'error':
        return 'error';
      case 'pending':
        return result ? (result.is_error ? 'error' : 'ok') : 'running';
    }
  }
  if (result) return result.is_error ? 'error' : 'ok';
  return 'cancelled';
}

const SERVER_LABELS: Record<string, string> = {
  web_search: 'Searched the web',
  web_fetch: 'Read a web page',
};

/** A readable label for a tool call when the live label is not available. */
export function fallbackToolLabel(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (name) {
    case 'web_search':
      return str('query') ? `Searched the web for “${str('query')}”` : 'Searched the web';
    case 'web_fetch':
    case 'fetch_url':
      return str('url') ? `Read ${hostOf(str('url'))}` : 'Read a web page';
    case 'search_web':
      return str('query') ? `Searched for “${str('query')}”` : 'Searched the web';
    case 'list_files':
      return str('path') ? `Looked in ${str('path')}` : 'Looked in a folder';
    case 'read_file':
      return str('path') ? `Read ${baseName(str('path'))}` : 'Read a file';
    case 'write_file':
      return str('path') ? `Wrote ${baseName(str('path'))}` : 'Wrote a file';
    case 'search_files':
      return 'Searched files';
    case 'create_folder':
      return str('path') ? `Created ${baseName(str('path'))}` : 'Created a folder';
    case 'move_files':
      return 'Moved files';
    case 'move_to_trash':
      return 'Moved items to the Trash';
    case 'find_places':
      return str('query') ? `Looked for ${str('query')} nearby` : 'Looked for places';
    case 'open_url':
      return str('url') ? `Opened ${hostOf(str('url'))}` : 'Opened a link';
    case 'control_computer':
      return 'Used your mouse and keyboard';
    case 'take_screenshot':
      return 'Looked at your screen';
    case 'set_mood':
      return str('mood') ? `Feeling ${str('mood')}` : 'Feeling…';
    case 'create_project':
      return str('name') ? `Created the project ${str('name')}` : 'Created a project';
    default:
      return SERVER_LABELS[name] ?? name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}

function baseName(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function hostOf(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function parseOptions(input: unknown): { title: string; items: OptionItem[] } | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as { title?: unknown; items?: unknown };
  if (!Array.isArray(i.items)) return null;
  return { title: typeof i.title === 'string' ? i.title : 'Options', items: i.items as OptionItem[] };
}

/** Build the turns of a conversation from what is stored. */
export function buildTranscript(detail: ConversationDetail): Turn[] {
  const runs = new Map(detail.runs.map((r) => [r.id, r]));
  const calls = new Map(detail.toolCalls.map((t) => [t.id, t]));
  const results = new Map<string, ContentBlock>();
  for (const m of detail.messages) {
    for (const b of m.content) {
      if ((b.type === 'tool_result' || b.type.endsWith('_tool_result')) && typeof b.tool_use_id === 'string')
        results.set(b.tool_use_id, b);
    }
  }

  const turns: Turn[] = [];
  let current = null as Turn | null;
  let sawAssistant = false;

  const startTurn = (m: StoredMessage, text: string[], attachments: UserAttachment[]): Turn => {
    const t: Turn = {
      key: `${m.id}-${turns.length}`,
      runId: m.runId,
      run: m.runId ? (runs.get(m.runId) ?? null) : null,
      userText: text,
      attachments,
      segments: [],
      createdAt: m.createdAt,
    };
    turns.push(t);
    sawAssistant = false;
    return t;
  };

  for (const m of detail.messages) {
    if (m.role === 'user') {
      const visible = visibleUserContent(m.content);
      if (visible.text.length || visible.attachments.length)
        current = startTurn(m, visible.text, visible.attachments);
      continue;
    }
    if (m.role !== 'assistant') continue;
    const turn: Turn = current ?? (current = startTurn({ ...m, content: [] }, [], []));
    if (!sawAssistant && m.runId && m.runId !== turn.runId) {
      turn.runId = m.runId;
      turn.run = runs.get(m.runId) ?? null;
    }
    sawAssistant = true;
    for (const b of m.content) {
      const id = typeof b.id === 'string' ? b.id : `${m.id}-${turn.segments.length}`;
      if (b.type === 'text' && typeof b.text === 'string') {
        if (!b.text.trim()) continue;
        const last = turn.segments[turn.segments.length - 1];
        if (last && last.kind === 'text') last.text += b.text;
        else
          turn.segments.push({
            kind: 'text',
            id: `${m.id}-t${turn.segments.length}`,
            text: b.text,
            streaming: false,
          });
      } else if (b.type === 'tool_use') {
        const name = String(b.name ?? '');
        if (name === 'update_plan') continue;
        if (name === 'ask_user') {
          const input = (b.input ?? {}) as {
            question?: string;
            options?: string[];
            allow_free_text?: boolean;
          };
          const r = resultText(results.get(id));
          const answered = /^The user answered: ([\s\S]*)$/.exec(r);
          turn.segments.push({
            kind: 'question',
            id,
            question: input.question ?? '',
            options: Array.isArray(input.options) ? input.options : [],
            allowFreeText: input.allow_free_text !== false,
            state: answered ? 'answered' : 'expired',
            answer: answered ? answered[1]! : null,
          });
          continue;
        }
        if (name === 'present_options') {
          const o = parseOptions(b.input);
          if (o) turn.segments.push({ kind: 'options', id, title: o.title, items: o.items });
          continue;
        }
        if (UI_TOOLS.has(name)) continue;
        const tc = calls.get(id);
        turn.segments.push({
          kind: 'tool',
          id,
          name,
          label: fallbackToolLabel(name, b.input),
          risk: tc?.risk ?? 'read',
          state: toolState(tc, results.get(id)),
          summary: tc?.summary ?? null,
          approval: tc?.approval ?? null,
          data: null,
        });
      } else if (b.type === 'server_tool_use') {
        const name = String(b.name ?? '');
        turn.segments.push({
          kind: 'tool',
          id,
          name,
          label: fallbackToolLabel(name, b.input),
          risk: 'read',
          state: 'ok',
          summary: null,
          approval: null,
          data: null,
        });
      }
    }
  }
  return turns;
}

/** The plan to show for a turn: live if the run is still streaming, else the stored one. */
export function planFor(turn: Turn, live: RunLive | undefined): PlanStep[] | null {
  return live?.plan ?? turn.run?.plan ?? null;
}

/**
 * Which segments to show for a turn, given the live state of its run.
 *
 * - The run is live and this window saw it start: the live segments are complete; use them until
 *   the conversation has been reloaded after the run finished.
 * - The run is live but this window joined midway: the stored segments as of the last load, then
 *   whatever arrived since (`offset` = live segments already present at load time).
 * - Otherwise the stored segments, enriched with live labels and results (e.g. a deploy URL).
 */
export function segmentsFor(turn: Turn, live: RunLive | undefined, loadedAt: number, offset = 0): Segment[] {
  if (!live) return turn.segments;
  const finishedBeforeLoad = live.finishedAt !== null && live.finishedAt <= loadedAt;
  if (!finishedBeforeLoad) {
    if (live.started) return live.segments;
    return [...turn.segments, ...live.segments.slice(offset)];
  }
  return turn.segments.map((s) => {
    if (s.kind !== 'tool') return s;
    const t = live.tools[s.id];
    return t ? { ...s, label: t.label || s.label, data: t.data ?? s.data } : s;
  });
}
