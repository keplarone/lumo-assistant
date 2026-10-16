import { describe, expect, it } from 'vitest';
import { emptyForm, validateForm } from '../src/lib/automationForm';
import { memoryWarning, progressFraction, progressText } from '../src/lib/localModels';
import { isWindowsPlatform, previewUrl } from '../src/lib/preview';
import { stripMarkdown } from '../src/lib/speech';
import { applyTheme, resolveTheme } from '../src/lib/theme';
import { DEFAULT_VAD, pickMimeType, vadStart, vadStep } from '../src/lib/voice';
import { buildTree } from '../src/screens/Projects';

describe('theme resolution', () => {
  it('uses explicit themes and follows the OS for system', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme(undefined, false)).toBe('light');
  });
  it('applies data-theme to the root', () => {
    const root = document.createElement('html');
    applyTheme('light', root);
    expect(root.getAttribute('data-theme')).toBe('light');
  });
});

describe('preview URLs', () => {
  it('uses the custom scheme on macOS and Linux', () => {
    expect(previewUrl('p1', 'index.html', false)).toBe('preview://localhost/p1/index.html');
  });
  it('uses http://preview.localhost on Windows', () => {
    expect(previewUrl('p1', 'pages/about me.html', true)).toBe(
      'http://preview.localhost/p1/pages/about%20me.html',
    );
  });
  it('drops traversal segments', () => {
    expect(previewUrl('p1', '../../etc/passwd', false)).toBe('preview://localhost/p1/etc/passwd');
    expect(previewUrl('p1', 'a\\b.css', false)).toBe('preview://localhost/p1/a/b.css');
  });
  it('detects Windows', () => {
    expect(isWindowsPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(true);
    expect(
      isWindowsPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', platform: 'MacIntel' }),
    ).toBe(false);
  });
});

describe('automation form validation', () => {
  const ok = { ...emptyForm(), name: 'Morning summary', prompt: 'Summarize my new files' };
  it('accepts a valid daily automation', () => {
    expect(validateForm(ok, [])).toEqual({});
  });
  it('requires a name and prompt', () => {
    const e = validateForm(emptyForm(), []);
    expect(e.name).toBeTruthy();
    expect(e.prompt).toBeTruthy();
  });
  it('checks time, interval and cron', () => {
    expect(validateForm({ ...ok, time: '25:00' }, []).time).toBeTruthy();
    expect(validateForm({ ...ok, kind: 'interval', minutes: '4' }, []).minutes).toBeTruthy();
    expect(validateForm({ ...ok, kind: 'interval', minutes: '1.5' }, []).minutes).toBeTruthy();
    expect(validateForm({ ...ok, kind: 'interval', minutes: '30' }, [])).toEqual({});
    expect(validateForm({ ...ok, kind: 'cron', expression: '0 9 * * *' }, []).expression).toBeTruthy();
    expect(validateForm({ ...ok, kind: 'cron', expression: '0 0 9 * * Mon-Fri' }, [])).toEqual({});
  });
  it('only allows tools Rust allows in automations', () => {
    expect(validateForm({ ...ok, allowedTools: ['write_file'] }, ['write_file'])).toEqual({});
    expect(validateForm({ ...ok, allowedTools: ['control_computer'] }, ['write_file']).allowedTools).toMatch(
      /control_computer/,
    );
  });
});

describe('voice', () => {
  it('prefers webm/opus', () => {
    expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMimeType(() => false)).toBeNull();
  });
  it('stops after silence that follows speech, and at the maximum length', () => {
    let s = vadStart(0);
    let r = vadStep(s, 0.2, 100);
    s = r.state;
    expect(r.stop).toBeNull();
    r = vadStep(s, 0.001, 600);
    s = r.state;
    expect(r.stop).toBeNull();
    r = vadStep(s, 0.001, 600 + DEFAULT_VAD.silenceMs + 50);
    expect(r.stop).toBe('silence');
    expect(vadStep(vadStart(0), 0.2, DEFAULT_VAD.maxMs + 1).stop).toBe('max');
  });
  it('strips markdown before speaking', () => {
    const t = stripMarkdown('# Done\n\nI moved **3 files** to [Documents](https://x.y) and ran `ls`.');
    expect(t).not.toMatch(/[#*`[\]]/);
    expect(t).toContain('3 files');
    expect(t).toContain('Documents');
    expect(t).not.toContain('https://');
  });
});

describe('on-device model helpers', () => {
  it('reports real progress only when a size is known', () => {
    expect(progressFraction({ completed: 5, total: 10 })).toBe(0.5);
    expect(progressFraction({ completed: 0, total: 0 })).toBeUndefined();
    expect(
      progressText({ model: 'm', status: 'pulling manifest', completed: 0, total: 0, done: false }),
    ).toBe('Pulling manifest');
    expect(
      progressText({
        model: 'm',
        status: 'downloading',
        completed: 1024 * 1024 * 1024,
        total: 2 * 1024 * 1024 * 1024,
        done: false,
      }),
    ).toBe('1.0 GB of 2.0 GB');
  });
  it('warns when a model may not fit', () => {
    expect(memoryWarning({ fits: true, minMemoryGb: 16 }, 32)).toBeNull();
    expect(memoryWarning({ fits: false, minMemoryGb: 32 }, 16)).toBe(
      'Needs 32 GB of memory; this computer has 16 GB.',
    );
  });
});

describe('project file tree', () => {
  it('nests files under folders', () => {
    const tree = buildTree([
      { path: 'index.html', kind: 'file', bytes: 10 },
      { path: 'css', kind: 'folder', bytes: null },
      { path: 'css/site.css', kind: 'file', bytes: 5 },
      { path: 'js/deep/app.js', kind: 'file', bytes: 1 },
    ]);
    const css = tree.find((n) => n.name === 'css');
    expect(css?.kind).toBe('folder');
    expect(css?.children.map((c) => c.name)).toEqual(['site.css']);
    expect(tree.find((n) => n.name === 'js')?.children[0]?.name).toBe('deep');
  });
});
