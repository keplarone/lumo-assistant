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
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  effort: 'medium',
  anthropicBaseUrl: 'https://api.anthropic.com',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiModel: 'llama3.1',
  localBaseUrl: 'http://127.0.0.1:11434',
  localModel: '',
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
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    projectId: null,
    origin: 'user',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'conv-2',
    title: 'Dinner spots near the office',
    agentId: null,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    projectId: null,
    origin: 'user',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'conv-3',
    title: 'Bakery website',
    agentId: null,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    projectId: 'proj-1',
    origin: 'user',
    createdAt: now,
    updatedAt: now,
  },
];
const localModel = (
  id: string,
  tier: string,
  base: string,
  gb: number,
  mem: number,
  summary: string,
  extra: object = {},
) => ({
  id,
  tier,
  baseModel: base,
  license: 'Apache-2.0',
  licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  downloadGb: gb,
  minMemoryGb: mem,
  summary,
  displayName: tier,
  installed: false,
  fits: true,
  selected: false,
  requiredPlan: null,
  ...extra,
});
// plans.rs PlanUsage for the Free plan.
const planRow = (id: string, name: string, monthlyTokens: number | null, extra: object = {}) => ({
  id,
  name,
  monthlyTokens,
  localModels: ['Orbit 3.8', 'Nebula 4.2', 'Solar 5.4', 'Nova 5.5'],
  cloudModels: true,
  automations: null,
  computerControl: true,
  ...extra,
});
const planUsage = {
  plan: 'free',
  tokensUsed: 640_000,
  tokensLimit: 1_000_000,
  percentUsed: 64,
  resetsAt: '2026-11-01T00:00:00+00:00',
  allowedModels: ['qwen3:4b', 'qwen3:8b'],
  cloudModels: false,
  automationsAllowed: 1,
  computerControl: false,
  plans: [
    planRow('free', 'Free', 1_000_000, {
      localModels: ['Orbit 3.8', 'Nebula 4.2'],
      cloudModels: false,
      automations: 1,
      computerControl: false,
    }),
    planRow('lite', 'Lumo Lite', 30_000_000, { automations: 10 }),
    planRow('pro', 'Lumo Pro', 150_000_000),
    planRow('unlimited', 'Lumo Unlimited', null),
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
    models: [
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-sonnet-5', 'Claude Sonnet 5'],
    ],
    updaterConfigured: false,
  },
  secrets_status: [
    { name: 'anthropic_api_key', label: 'Anthropic API key', set: true },
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
  list_grants: [],
  list_capabilities: [],
  license_status: {
    plan: 'free',
    hasKey: false,
    licensingConfigured: true,
    checkoutLite: 'https://whop.com/checkout/test-lite',
    checkoutPro: 'https://whop.com/checkout/test-pro',
    checkoutUnlimited: 'https://whop.com/checkout/test-unlimited',
    checkedAt: null,
  },
  plan_usage: planUsage,
  local_models_status: {
    brand: 'Lumo on-device models',
    runtimeRunning: true,
    runtimeVersion: '0.12.3',
    runtimeDownloadUrl: 'https://ollama.com/download',
    memoryGb: 16,
    models: [
      localModel(
        'qwen3:4b',
        'Orbit 3.8',
        'Qwen3 4B',
        2.6,
        8,
        'Quick answers and simple tasks on most laptops.',
        { installed: true, selected: true },
      ),
      localModel(
        'qwen3:8b',
        'Nebula 4.2',
        'Qwen3 8B',
        5.2,
        16,
        'Good everyday choice for planning and using tools.',
      ),
      localModel(
        'gpt-oss:20b',
        'Solar 5.4',
        'gpt-oss 20B',
        14,
        16,
        'Stronger reasoning; needs a recent computer with 16 GB of memory or more.',
        { requiredPlan: 'lite' },
      ),
      localModel(
        'qwen3:30b',
        'Nova 5.5',
        'Qwen3 30B-A3B',
        19,
        32,
        'The most capable on-device option, for machines with 32 GB of memory or more.',
        { fits: false, requiredPlan: 'lite' },
      ),
    ],
    otherInstalled: [],
  },
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

test('settings: model with on-device models', async ({ page }) => {
  await boot(page, {
    route: '#/settings/model',
    fixtures: { get_settings: { ...settings, provider: 'local', localModel: 'qwen3:4b' } },
  });
  await expect(page.getByText('Nebula 4.2')).toBeVisible();
  await page.getByRole('button', { name: 'Download' }).first().click();
  await emit(page, 'local-model-progress', {
    model: 'qwen3:8b',
    status: 'pulling 3a9c',
    completed: 2_150_000_000,
    total: 5_200_000_000,
    done: false,
  });
  await expect(page.getByRole('progressbar', { name: 'Downloading Nebula 4.2' })).toBeVisible();
  await shot(page, 'settings-model-local');
});

test('chat: a plan limit shows the reason and opens checkout', async ({ page }) => {
  const message =
    'You’ve used all of this month’s Free usage. It resets on November 1. Upgrade to Lite or Pro for 30× or 150× more, or to Unlimited for no limit.';
  await boot(page, {
    route: '#/',
    fixtures: {
      start_run_error: { code: 'plan_limit', message },
      plan_usage: { ...planUsage, tokensUsed: 1_000_000, percentUsed: 100 },
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

test('settings: models the plan doesn’t include are marked', async ({ page }) => {
  await boot(page, {
    route: '#/settings/model',
    fixtures: { get_settings: { ...settings, provider: 'local', localModel: 'qwen3:4b' } },
  });
  await expect(page.getByText('Nova 5.5')).toBeVisible();
  await expect(
    page.locator('.lm-local-model').filter({ hasText: 'Solar 5.4' }).getByText('Lite', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Included with Lumo Lite and above.')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(1);
});

test('settings: on-device runtime missing', async ({ page }) => {
  const st = base.local_models_status as Record<string, unknown>;
  await boot(page, {
    route: '#/settings/model',
    fixtures: {
      get_settings: { ...settings, provider: 'local' },
      local_models_status: {
        ...st,
        runtimeRunning: false,
        runtimeVersion: null,
        models: (st.models as object[]).map((m) => ({ ...m, installed: false, selected: false })),
      },
    },
  });
  await expect(page.getByText('On-device models need the free Ollama app')).toBeVisible();
  await shot(page, 'settings-local-no-runtime');
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
      await expect(page.getByText('On-device models: Orbit 3.8 and Nebula 4.2')).toBeVisible();
      await expect(page.getByText('30× more usage than Free')).toBeVisible();
      await expect(page.getByText('150× more usage than Free')).toBeVisible();
      await expect(page.getByText('$124.99')).toBeVisible();
    }
    await page.waitForTimeout(300);
    await shot(page, `settings-${section}`);
  }
  await expect(page.getByText('Apache-2.0').first()).toBeVisible();
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

test('onboarding, model step offers the free on-device path first', async ({ page }) => {
  await boot(page, {
    route: '#/',
    fixtures: {
      get_settings: { ...settings, onboarded: false, userName: null },
      secrets_status: [{ name: 'anthropic_api_key', label: 'Anthropic API key', set: false }],
    },
  });
  await page
    .getByRole('button', { name: /Get started|Continue|Next/ })
    .first()
    .click();
  await expect(page.getByText('Orbit 3.8')).toBeVisible();
  await settle(page);
  await shot(page, 'onboarding-model');
});

test('a build with accounts asks people to sign in first', async ({ page }) => {
  const signedOut = {
    configured: true,
    signedIn: false,
    signingIn: false,
    account: null,
    recommendPasskey: false,
    recommendTwoStep: false,
  };
  await boot(page, {
    route: '#/',
    fixtures: { get_settings: { ...settings, account: null }, account_status: signedOut },
  });
  await expect(page.getByRole('heading', { name: 'Welcome to Lumo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message to Lumo' })).toHaveCount(0);
  await settle(page);
  await shot(page, 'sign-in');
});
