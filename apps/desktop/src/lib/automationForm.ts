/** The automation editor's form model, validation and conversion to/from the Rust types. */
import type { Automation, AutomationInput, Trigger, Weekday } from './ipc';

export const WEEKDAYS: { id: Weekday; short: string; long: string }[] = [
  { id: 'mon', short: 'M', long: 'Monday' },
  { id: 'tue', short: 'T', long: 'Tuesday' },
  { id: 'wed', short: 'W', long: 'Wednesday' },
  { id: 'thu', short: 'T', long: 'Thursday' },
  { id: 'fri', short: 'F', long: 'Friday' },
  { id: 'sat', short: 'S', long: 'Saturday' },
  { id: 'sun', short: 'S', long: 'Sunday' },
];

export type TriggerKind = 'daily' | 'interval' | 'cron';

export interface AutomationForm {
  name: string;
  prompt: string;
  agentId: string | null;
  kind: TriggerKind;
  time: string;
  days: Weekday[];
  minutes: string;
  expression: string;
  allowedTools: string[];
  notify: boolean;
  enabled: boolean;
}

export type FormErrors = Partial<
  Record<'name' | 'prompt' | 'time' | 'days' | 'minutes' | 'expression' | 'allowedTools', string>
>;

export function emptyForm(): AutomationForm {
  return {
    name: '',
    prompt: '',
    agentId: null,
    kind: 'daily',
    time: '09:00',
    days: [],
    minutes: '60',
    expression: '',
    allowedTools: [],
    notify: true,
    enabled: true,
  };
}

export function formFromAutomation(a: Automation): AutomationForm {
  const f: AutomationForm = {
    ...emptyForm(),
    name: a.name,
    prompt: a.prompt,
    agentId: a.agentId,
    allowedTools: [...a.allowedTools],
    notify: a.notify,
    enabled: a.enabled,
  };
  switch (a.trigger.type) {
    case 'daily':
      return { ...f, kind: 'daily', time: a.trigger.time, days: [...a.trigger.days] };
    case 'interval':
      return { ...f, kind: 'interval', minutes: String(a.trigger.minutes) };
    case 'cron':
      return { ...f, kind: 'cron', expression: a.trigger.expression };
  }
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Mirrors automations.rs validate/cron_for so mistakes are caught before saving. */
export function validateForm(f: AutomationForm, allowable: string[]): FormErrors {
  const e: FormErrors = {};
  const name = f.name.trim();
  if (!name) e.name = 'Give the automation a name.';
  else if (name.length > 100) e.name = 'Use 100 characters or fewer.';
  const prompt = f.prompt.trim();
  if (!prompt) e.prompt = 'Describe what Lumo should do.';
  else if (prompt.length > 10_000) e.prompt = 'Use 10,000 characters or fewer.';
  if (f.kind === 'daily') {
    if (!TIME.test(f.time)) e.time = 'Enter a time as HH:MM, for example 08:30.';
  } else if (f.kind === 'interval') {
    const n = Number(f.minutes);
    if (!/^\d+$/.test(f.minutes.trim()) || !Number.isInteger(n))
      e.minutes = 'Enter a whole number of minutes.';
    else if (n < 5 || n > 10_080) e.minutes = 'Choose between 5 minutes and 7 days (10,080 minutes).';
  } else {
    const fields = f.expression.trim().split(/\s+/).filter(Boolean);
    if (fields.length < 6 || fields.length > 7)
      e.expression =
        'Use six or seven fields: seconds, minutes, hours, day, month, weekday (and optionally year).';
  }
  const bad = f.allowedTools.filter((t) => !allowable.includes(t));
  if (bad.length) e.allowedTools = `${bad.join(', ')} can't be allowed in an automation.`;
  return e;
}

export function triggerFromForm(f: AutomationForm): Trigger {
  switch (f.kind) {
    case 'daily':
      return {
        type: 'daily',
        time: f.time,
        days: WEEKDAYS.map((d) => d.id).filter((d) => f.days.includes(d)),
      };
    case 'interval':
      return { type: 'interval', minutes: Number(f.minutes) };
    case 'cron':
      return { type: 'cron', expression: f.expression.trim().replace(/\s+/g, ' ') };
  }
}

export function inputFromForm(f: AutomationForm): AutomationInput {
  return {
    name: f.name.trim(),
    prompt: f.prompt.trim(),
    agentId: f.agentId,
    trigger: triggerFromForm(f),
    allowedTools: [...f.allowedTools],
    enabled: f.enabled,
    notify: f.notify,
  };
}

export function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case 'daily': {
      const days =
        t.days.length === 0 || t.days.length === 7
          ? 'Every day'
          : t.days.length === 5 && !t.days.includes('sat') && !t.days.includes('sun')
            ? 'Weekdays'
            : WEEKDAYS.filter((d) => t.days.includes(d.id))
                .map((d) => d.long.slice(0, 3))
                .join(', ');
      return `${days} at ${t.time}`;
    }
    case 'interval':
      if (t.minutes % 1440 === 0)
        return `Every ${t.minutes / 1440 === 1 ? 'day' : `${t.minutes / 1440} days`}`;
      if (t.minutes % 60 === 0) return `Every ${t.minutes / 60 === 1 ? 'hour' : `${t.minutes / 60} hours`}`;
      return `Every ${t.minutes} minutes`;
    case 'cron':
      return `Schedule: ${t.expression}`;
  }
}

/** Plain explanations of the write tools an automation can be allowed to use. */
export const TOOL_EXPLANATIONS: Record<string, string> = {
  write_file: 'Create or change files in your granted folders',
  create_folder: 'Create folders in your granted folders',
  move_files: 'Move or rename files in your granted folders',
  move_to_trash: 'Move small numbers of files to the Trash (larger deletions always need you)',
  write_clipboard: 'Put text on your clipboard',
  open_url: 'Open ordinary web pages in your browser (never checkout or sign-in pages)',
};
