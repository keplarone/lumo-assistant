import { describe, expect, it } from 'vitest';
import { fallbackToolLabel, isMachineContext, visibleUserContent } from '../src/lib/transcript';

describe('hiding machine context', () => {
  it('recognizes <context> and <memory> blocks', () => {
    expect(isMachineContext('<context>\ntoday: Monday\n</context>')).toBe(true);
    expect(isMachineContext('  <memory>likes tea</memory>')).toBe(true);
    expect(isMachineContext('Please tidy my <context> folder')).toBe(false);
  });

  it('shows only what the user wrote or attached', () => {
    const v = visibleUserContent([
      { type: 'text', text: '<context>\nlocal time 09:00\n</context>\n<memory>name is Ada</memory>' },
      { type: 'text', text: 'Sort my downloads' },
      {
        type: 'text',
        text: 'The user attached notes.txt (/home/a/notes.txt):\n<untrusted_content>secret plans</untrusted_content>',
      },
      { type: 'image', source: {} },
    ]);
    expect(v.text).toEqual(['Sort my downloads']);
    expect(v.attachments).toEqual([
      { name: 'notes.txt', kind: 'file' },
      { name: 'Image', kind: 'image' },
    ]);
    expect(JSON.stringify(v)).not.toContain('local time');
    expect(JSON.stringify(v)).not.toContain('secret plans');
  });

  it('labels computer control', () => {
    expect(fallbackToolLabel('control_computer', {})).toMatch(/mouse and keyboard/);
  });
});
