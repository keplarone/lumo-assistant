/** Turns what the agent is doing into mascot behavior events. Pure, so it is unit tested. */
import type { AgentPhase, MascotEvent } from '@lumo/mascot';
import type { AgentEvent } from './ipc';

const SEARCH_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'fetch_url',
  'search_web',
  'find_places',
  'search_files',
]);
const TYPING_TOOLS = new Set(['write_file', 'write_clipboard']);

const agent = (phase: AgentPhase): MascotEvent => ({ type: 'agent', phase });

export function mascotEventsFor(ev: AgentEvent): MascotEvent[] {
  switch (ev.type) {
    case 'run_started':
      return [agent('thinking')];
    case 'phase':
      switch (ev.phase) {
        case 'understanding':
          return [agent('thinking')];
        case 'planning':
          return [agent('planning')];
        case 'executing':
        case 'verifying':
          return [agent('working')];
        case 'reporting':
          return [agent('speaking')];
      }
      return [];
    case 'tool_started':
      if (ev.name === 'update_plan') return [agent('planning')];
      if (SEARCH_TOOLS.has(ev.name)) return [agent('searching')];
      if (TYPING_TOOLS.has(ev.name)) return [agent('typing')];
      if (ev.name === 'ask_user' || ev.name === 'present_options' || ev.name === 'set_mood') return [];
      return [agent('working')];
    case 'text_delta':
      return [agent('speaking')];
    case 'approval_requested':
      return [agent('awaiting_approval'), { type: 'attend', target: 'approval', durationMs: 4000 }];
    case 'approval_resolved':
      return [agent('working')];
    case 'question':
      return [agent('uncertain'), { type: 'attend', target: 'question', durationMs: 4000 }];
    case 'options':
      return [{ type: 'attend', target: 'options', durationMs: 2500 }];
    case 'mood':
      // Closest existing expression; the next agent phase replaces it as usual.
      switch (ev.mood) {
        case 'warm':
        case 'happy':
        case 'celebrating':
          return [agent('done')]; // a happy look (with a small celebration pulse)
        case 'concerned':
          return [agent('uncertain')]; // soft tilt, crest lowered
        case 'calm':
        case 'neutral':
          return [agent('idle')];
      }
      return [];
    case 'run_finished':
      if (ev.status === 'done') return [agent('done')];
      if (ev.status === 'failed' || ev.status === 'refused') return [agent('failed')];
      if (ev.status === 'needs_attention') return [agent('uncertain')];
      return [agent('idle')];
    default:
      return [];
  }
}
