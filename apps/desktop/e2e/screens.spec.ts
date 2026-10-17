/**
 * Visual check of the main screens against the real UI code. The Tauri bridge is replaced by a tiny
 * in-page mock defined only in this file: it answers commands with fixture data and lets the test
 * emit events the way Rust would. App code never contains mock data.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../test-results/', import.meta.url));
mkdirSync(OUT, { recursive: true });

type Fixtures = Record<string, unknown>;

// Two hours ago, so relative times read naturally whenever the test runs.
const now = new Date(Date.now() - 2 * 3600_000).toISOString();
const settings = {
  onboarded: true,
  userName: 'Ada',
  theme: 'dark',
  model: 'auto',
  memoryEnabled: true,
  webSearchEnabled: true,
  globalShortcut: 'Alt+Space',
  closeToTray: true,
  retentionDays: null,
  location: null,
  automationsPaused: false,
  maxToolCallsPerRun: 40,
  sttBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'whisper-1',
  ttsEnabled: false,
  mascotEnabled: true,
  reducedMotion: false,
  plan: 'free',
  planCheckedAt: null,
};
const conversations = [
  {
    id: 'conv-1',
    title: 'Sort my Downloads',
    agentId: null,
    provider: 'lumo',
    model: 'auto',
    projectId: null,
    origin: 'user',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'conv-2',
    title: 'Dinner spots near the office',
    agentId: null,
    provider: 'lumo',
    model: 'auto',
    projectId: null,
    origin: 'user',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'conv-3',
    title: 'Bakery website',
    agentId: null,
    provider: 'lumo',
    model: 'auto',
    projectId: 'proj-1',
    origin: 'user',
    createdAt: now,
    updatedAt: now,
  },
];
// plans.rs PlanUsage for the Free plan, with the model gateway's catalog.
const model = (id: string, name: string, blurb: string, vision = true) => ({ id, name, blurb, vision });
const planUsage = {
  plan: 'free',
  percentUsed: 64,
  resetsAt: '2026-11-01T00:00:00.000Z',
  usageError: null,
  automationsAllowed: 1,
  computerControl: false,
  plans: [
    {
      id: 'free',
      name: 'Free',
      priceUsd: 0,
      automations: 1,
      computerControl: false,
      defaultModel: 'nvidia/nemotron-3.5-super-vl:free',
      models: [
        model(
          'nvidia/nemotron-3.5-super-vl:free',
          'Nemotron 3.5 Super VL',
          'Free model. Can be slow or busy at peak times.',
        ),
        model(
          'xingchen-agi/xing4.0-29b-a4b:free',
          'Xing4.0 29b A4b',
          'Free model. Can be slow or busy at peak times.',
          false,
        ),
      ],
    },
    {
      id: 'lite',
      name: 'Lumo Lite',
      priceUsd: 19.99,
      automations: 10,
      computerControl: true,
      defaultModel: 'anthropic/claude-haiku-5.5',
      models: [
        model(
          'anthropic/claude-haiku-5.5',
          'Claude Haiku 5.5',
          'Fast and careful. Great for everyday tasks.',
        ),
        model('openai/gpt-6-luna', 'GPT-6 Luna', 'Quick answers and light tasks.'),
      ],
    },
    {
      id: 'pro',
      name: 'Lumo Pro',
      priceUsd: 49.99,
      automations: null,
      computerControl: true,
      defaultModel: 'anthropic/claude-sonnet-5.5',
      models: [
        model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'The strongest at long, many-step tasks.'),
        model(
          'anthropic/claude-haiku-5.5',
          'Claude Haiku 5.5',
          'Fast and careful. Great for everyday tasks.',
        ),
        model('openai/gpt-6-sol', 'GPT-6 Sol', 'Strong at writing, research and planning.'),
      ],
    },
  ],
};
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Rise Bakery</title><link rel="stylesheet" href="style.css"></head><body><header><h1>Rise Bakery</h1><p>Sourdough, baked every morning.</p></header><main><section><h2>Today</h2><ul><li>Country loaf</li><li>Rye with caraway</li><li>Cardamom buns</li></ul></section></main></body></html>`;
const css = `body{font-family:Georgia,serif;margin:0;background:#fbf6ee;color:#3b2a1a}header{padding:48px 32px;background:#e9d8bf}h1{margin:0;font-size:40px}main{padding:24px 32px}`;

const base: Fixtures = {
  get_settings: settings,
  save_settings: settings,
  app_info: {
    version: '0.1.0',
    os: 'linux',
    keychain: null,
    dataDir: '/home/ada/.local/share/one.keplar.lumo',
    logDir: '/home/ada/.local/share/one.keplar.lumo/logs',
    updaterConfigured: false,
  },
  secrets_status: [
    { name: 'brave_search_api_key', label: 'Brave Search API key', set: false },
    { name: 'stt_api_key', label: 'Speech-to-text key', set: false },
  ],
  list_agents: [],
  list_conversations: conversations,
  list_active_runs: [],
  list_runs: [],
  list_projects: [
    {
      id: 'proj-1',
      name: 'Rise Bakery',
      path: '/home/ada/Lumo Projects/Rise Bakery',
      kind: 'website',
      conversationId: 'conv-3',
      createdAt: now,
      updatedAt: now,
      siteUrl: null,
      githubRepo: null,
    },
  ],
  project_files: [
    { path: 'index.html', kind: 'file', bytes: html.length },
    { path: 'style.css', kind: 'file', bytes: css.length },
    { path: 'images', kind: 'folder', bytes: null },
    { path: 'images/loaf.jpg', kind: 'file', bytes: 182_331 },
  ],
  read_project_file: html,
  project_history: [],
  integrations_status: [],
  ordering_apps: [],
  recent_orders: [],
  list_grants: [],
  list_capabilities: [],
  license_status: {
    plan: 'free',
    hasKey: false,
    licensingConfigured: true,
    checkoutLite: 'https://whop.com/checkout/test-lite',
    checkoutPro: 'https://whop.com/checkout/test-pro',
    checkedAt: null,
  },
  plan_usage: planUsage,
};

/** Install the bridge mock before any app code runs. */
async function boot(page: Page, opts: { route: string; window?: string; fixtures?: Fixtures }) {
  await page.addInitScript(
    ({ fixtures, label }) => {
      const callbacks = new Map<number, (data: unknown) => void>();
      const listeners = new Map<string, number[]>();
      let next = 1;
      const calls: { cmd: string; args: unknown }[] = [];
      const w = window as unknown as Record<string, unknown>;
      w.__lumoCalls = calls;
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
        transformCallback: (cb: (d: unknown) => void) => {
          const id = next++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (p: string) => p,
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          calls.push({ cmd, args });
          if (cmd === 'plugin:event|listen') {
            const list = listeners.get(args.event as string) ?? [];
            list.push(args.handler as number);
            listeners.set(args.event as string, list);
            return args.handler;
          }
          if (cmd === 'plugin:event|unlisten') {
            const list = listeners.get(args.event as string) ?? [];
            listeners.set(
              args.event as string,
              list.filter((h) => h !== args.eventId),
            );
            return null;
          }
          if (cmd.startsWith('plugin:')) return null;
          if (cmd === 'start_run') {
            if ('start_run_error' in fixtures) throw fixtures.start_run_error;
            return { runId: 'run-1', conversationId: 'conv-1' };
          }
          return cmd in fixtures ? structuredClone(fixtures[cmd]) : null;
        },
      };
      w.__lumoEmit = (event: string, payload: unknown) => {
        for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
      };
    },
    { fixtures: { ...base, ...opts.fixtures }, label: opts.window ?? 'main' },
  );
  await page.goto(`/${opts.route}`);
}

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ([e, p]) =>
      (window as unknown as { __lumoEmit: (e: string, p: unknown) => void }).__lumoEmit(e as string, p),
    [event, payload] as const,
  );
const agent = (page: Page, event: object) =>
  emit(page, 'agent-event', { runId: 'run-1', conversationId: 'conv-1', event });
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}${name}.png` });
/** Let the owl's WebGL canvas render a few frames. */
const settle = (page: Page, ms = 1200) => page.waitForTimeout(ms);

test('home, empty state', async ({ page }) => {
  await boot(page, { route: '#/' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ada');
  await expect(page.getByRole('textbox', { name: 'Message to Lumo' })).toBeFocused();
  await settle(page, 2500);
  await shot(page, 'home-empty');
});

test('conversation with an approval card', async ({ page }) => {
  const detail = {
    conversation: conversations[0],
    messages: [
      {
        id: 'm1',
        seq: 1,
        role: 'user',
        runId: 'run-1',
        createdAt: now,
        content: [
          { type: 'text', text: '<context>\nLocal time: Friday 09:12\n</context>' },
          {
            type: 'text',
            text: 'Sort my Downloads folder: put PDFs in Documents/Receipts and screenshots in Pictures.',
          },
        ],
      },
    ],
    runs: [
      {
        id: 'run-1',
        conversationId: 'conv-1',
        origin: 'user',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        error: null,
        summary: null,
        plan: null,
        title: null,
      },
    ],
    toolCalls: [],
  };
  await boot(page, { route: '#/', fixtures: { get_conversation: detail } });
  const box = page.getByRole('textbox', { name: 'Message to Lumo' });
  await box.fill('Sort my Downloads folder: put PDFs in Documents/Receipts and screenshots in Pictures.');
  await box.press('Enter');
  await expect(page).toHaveURL(/#\/c\/conv-1/);
  await agent(page, { type: 'run_started', runId: 'run-1', conversationId: 'conv-1' });
  await agent(page, { type: 'phase', phase: 'executing' });
  await agent(page, {
    type: 'plan',
    steps: [
      { title: 'Look through Downloads', status: 'done' },
      { title: 'Move 14 PDFs to Documents/Receipts', status: 'active' },
      { title: 'Move 9 screenshots to Pictures', status: 'pending' },
    ],
  });
  await agent(page, {
    type: 'tool_started',
    callId: 't1',
    name: 'list_files',
    label: 'Looking in Downloads',
    risk: 'read',
    input: {},
  });
  await agent(page, {
    type: 'tool_finished',
    callId: 't1',
    name: 'list_files',
    ok: true,
    summary: '62 items',
    data: null,
  });
  await agent(page, {
    type: 'text_delta',
    text: 'I found **14 PDFs** that look like receipts and **9 screenshots**. I’ll start with the receipts.',
  });
  await agent(page, {
    type: 'tool_started',
    callId: 't2',
    name: 'move_files',
    label: 'Moving 14 files to Receipts',
    risk: 'write',
    input: {},
  });
  await agent(page, {
    type: 'approval_requested',
    approvalId: 'appr-1',
    callId: 't2',
    tier: 'write',
    native: false,
    preview: {
      title: 'Move 14 files to Documents/Receipts',
      details: [
        ['From', '~/Downloads'],
        ['To', '~/Documents/Receipts'],
        ['Files', 'invoice-0912.pdf, receipt-amazon.pdf and 12 more'],
      ],
      warning: null,
    },
  });
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await expect(page.getByText('Local time')).toHaveCount(0);
  await settle(page);
  await shot(page, 'conversation-approval');
  await page.getByRole('button', { name: 'Allow once' }).click();
  const calls = await page.evaluate(() =>
    (window as unknown as { __lumoCalls: { cmd: string; args: unknown }[] }).__lumoCalls.filter(
      (c) => c.cmd === 'resolve_approval',
    ),
  );
  expect(calls).toEqual([{ cmd: 'resolve_approval', args: { approvalId: 'appr-1', answer: 'once' } }]);
});

test('computer-control banner', async ({ page }) => {
  await boot(page, {
    route: '#/',
    fixtures: {
      list_active_runs: [
        { runId: 'run-9', conversationId: 'conv-1', origin: 'user', title: 'Fill the form', startedAt: now },
      ],
    },
  });
  await expect(page.getByRole('textbox', { name: 'Message to Lumo' })).toBeVisible();
  await emit(page, 'input-control', { active: true, stopShortcut: 'Alt+Shift+Escape' });
  const banner = page.getByRole('alert').filter({ hasText: 'mouse and keyboard' });
  await expect(banner).toBeVisible();
  await settle(page);
  await shot(page, 'input-control-banner');
  await banner.getByRole('button', { name: /Stop/ }).click();
  const cancels = await page.evaluate(() =>
    (window as unknown as { __lumoCalls: { cmd: string; args: unknown }[] }).__lumoCalls.filter(
      (c) => c.cmd === 'cancel_run',
    ),
  );
  expect(cancels).toEqual([{ cmd: 'cancel_run', args: { runId: 'run-9' } }]);
});

test('settings: model picker with the plan’s models', async ({ page }) => {
  await boot(page, { route: '#/settings/model' });
  await expect(page.getByText('64% of this month’s usage')).toBeVisible();
  await expect(page.getByText('Free models are shared')).toBeVisible();
  await page.getByRole('combobox', { name: 'Model' }).click();
  await expect(page.getByRole('option', { name: 'Auto (Nemotron 3.5 Super VL)' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Claude Haiku 5.5 · Lite' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByText(/Ollama|on-device/i)).toHaveCount(0);
  await shot(page, 'settings-model');
});

test('chat: a plan limit shows the reason and opens checkout', async ({ page }) => {
  const message =
    'You’ve used all of this month’s Free usage. It resets on November 1. Upgrade to Lumo Lite or Lumo Pro in Settings → Plans for much more.';
  await boot(page, {
    route: '#/',
    fixtures: {
      start_run_error: { code: 'plan_limit', message },
      plan_usage: { ...planUsage, percentUsed: 100 },
    },
  });
  await expect(page.getByText('You’ve used all of this month’s usage. It resets on')).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Message to Lumo' });
  await box.fill('Sort my Downloads');
  await box.press('Enter');
  await expect(page.getByText(message)).toBeVisible();
  await expect(box).toHaveValue('Sort my Downloads');
  await settle(page);
  await shot(page, 'chat-plan-limit');
  await page.getByRole('button', { name: 'Upgrade to Lumo Lite' }).click();
  const opened = await page.evaluate(() =>
    (window as unknown as { __lumoCalls: { cmd: string; args: unknown }[] }).__lumoCalls.filter(
      (c) => c.cmd === 'open_external_url',
    ),
  );
  expect(opened).toEqual([
    { cmd: 'open_external_url', args: { url: 'https://whop.com/checkout/test-lite' } },
  ]);
});

test('settings: general, plans, help, privacy, about', async ({ page }) => {
  await boot(page, { route: '#/settings/general' });
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await shot(page, 'settings');
  for (const [section, heading] of [
    ['plans', 'Plans'],
    ['help', 'Help'],
    ['privacy', 'Privacy & security'],
    ['about', 'Lumo'],
  ] as const) {
    await page.goto(`/#/settings/${section}`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (section === 'plans') {
      await expect(page.getByText('64% of this month’s usage')).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'This month’s usage' })).toBeVisible();
      await expect(page.getByText('Adds Claude Haiku 5.5 and GPT-6 Luna')).toBeVisible();
      await expect(page.getByText('$49.99')).toBeVisible();
      await expect(page.getByText(/Unlimited usage|\$124\.99/)).toHaveCount(0);
    }
    await page.waitForTimeout(300);
    await shot(page, `settings-${section}`);
  }
  await expect(page.getByText(/Apache-2\.0/).first()).toBeVisible();
});

test('projects workspace with editor and preview', async ({ page, context }) => {
  // On Windows the preview is served from http://preview.localhost; emulate that so the iframe has content.
  await context.route('http://preview.localhost/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: css });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    }),
  );
  await boot(page, {
    route: '#/projects/proj-1',
    fixtures: { get_conversation: { conversation: conversations[2], messages: [], runs: [], toolCalls: [] } },
  });
  await expect(page.getByRole('heading', { name: 'Rise Bakery' })).toBeVisible();
  await page.getByRole('button', { name: 'index.html' }).click();
  await expect(page.locator('.cm-content')).toContainText('Sourdough');
  const frame = page.locator('iframe.lm-preview-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
  await expect(frame).toHaveAttribute('src', /^http:\/\/preview\.localhost\/proj-1\//);
  await page.waitForTimeout(800);
  await shot(page, 'projects');
});

test('compact window', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 560 });
  await boot(page, { route: '#/compact', window: 'compact' });
  await expect(page.getByRole('textbox', { name: 'Message to Lumo' })).toBeVisible();
  await settle(page);
  await shot(page, 'compact');
});

test('onboarding needs no model setup', async ({ page }) => {
  await boot(page, {
    route: '#/',
    fixtures: { get_settings: { ...settings, onboarded: false, userName: null } },
  });
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByText('What should Lumo call you?')).toBeVisible();
  await expect(page.getByText(/API key|on-device|Ollama/i)).toHaveCount(0);
  await settle(page);
  await shot(page, 'onboarding-you');
});
