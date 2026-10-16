import { describe, expect, it } from 'vitest';
import { emptyForm, validateForm } from '../src/lib/automationForm';
import type { PlanInfo } from '../src/lib/ipc';
import { asPlanId, modelName, nextPlan, planFeatures, planModels, planPrice } from '../src/lib/plans';
import { isWindowsPlatform, previewUrl } from '../src/lib/preview';
import { chooseVoice, stripMarkdown } from '../src/lib/speech';
import { applyTheme, resolveTheme } from '../src/lib/theme';
import { DEFAULT_VAD, pcm16Base64, pickMimeType, vadStart, vadStep } from '../src/lib/voice';
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

describe('plan helpers', () => {
  const plans = [
    {
      id: 'free',
      name: 'Free',
      priceUsd: 0,
      automations: 1,
      computerControl: false,
      defaultModel: 'f/free:free',
      models: [{ id: 'f/free:free', name: 'Free One', blurb: '', vision: false }],
    },
    {
      id: 'lite',
      name: 'Lumo Lite',
      priceUsd: 19.99,
      automations: 10,
      computerControl: true,
      defaultModel: 'a/haiku',
      models: [{ id: 'a/haiku', name: 'Haiku', blurb: '', vision: true }],
    },
    {
      id: 'pro',
      name: 'Lumo Pro',
      priceUsd: 49.99,
      automations: null,
      computerControl: true,
      defaultModel: 'a/sonnet',
      models: [
        { id: 'a/sonnet', name: 'Sonnet', blurb: '', vision: true },
        { id: 'a/haiku', name: 'Haiku', blurb: '', vision: true },
      ],
    },
  ] as PlanInfo[];
  it('prices, model lists and names come from the catalog', () => {
    expect(planPrice(plans[0]!)).toEqual({ price: '$0' });
    expect(planPrice(plans[1]!)).toEqual({ price: '$19.99', period: '/month' });
    expect(planModels(plans, 'pro').auto?.name).toBe('Sonnet');
    expect(planModels(plans, 'lite').models.map((m) => m.id)).toEqual(['a/haiku']);
    expect(modelName(plans, 'a/sonnet')).toBe('Sonnet');
    expect(modelName(plans, 'gone/model')).toBe('gone/model');
    expect(planFeatures(plans, 2)).toContain('Adds Sonnet');
    expect(nextPlan('pro')).toBeNull();
    expect(asPlanId('unlimited')).toBe('free');
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

describe('mascot voice', () => {
  const v = (name: string, lang: string, localService = true, isDefault = false) =>
    ({ name, lang, localService, default: isDefault, voiceURI: name }) as SpeechSynthesisVoice;
  const voices = [
    v('Daniel', 'en-GB', true, true),
    v('Google US English', 'en-US', false),
    v('Samantha', 'en-US'),
    v('Amélie', 'fr-CA'),
  ];

  it('picks a light on-device voice, pitched up, for the Lumo style', () => {
    const c = chooseVoice('lumo', voices, 'en-US');
    expect(c.voice?.name).toBe('Samantha');
    expect(c.pitch).toBeGreaterThan(1.3);
  });

  it('never picks a voice that runs online', () => {
    const c = chooseVoice('lumo', [v('Google US English', 'en-US', false), v('Daniel', 'en-GB')], 'en');
    expect(c.voice?.name).toBe('Daniel');
  });

  it('keeps the system default at normal pitch', () => {
    expect(chooseVoice('system', voices, 'en')).toMatchObject({ pitch: 1, rate: 1 });
    expect(chooseVoice('system', voices, 'en').voice?.name).toBe('Daniel');
  });
});

describe('on-device transcription input', () => {
  it('packs samples as 16-bit little-endian PCM', () => {
    const b64 = pcm16Base64(new Float32Array([0, 0.5, -0.5, 2, -2]));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true))).toEqual([
      0, 16384, -16384, 32767, -32768,
    ]);
  });
});
