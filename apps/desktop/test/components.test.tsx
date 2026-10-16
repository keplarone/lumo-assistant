import { TooltipProvider } from '@lumo/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const listen = vi.fn(async () => () => {});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...a: unknown[]) => listen(...(a as [])),
  emitTo: vi.fn(),
}));

const announce = vi.fn();
// plans.rs PlanUsage, as plan_usage returns it for the Free plan.
const model = (id: string, name: string, vision = true) => ({ id, name, blurb: `${name} blurb`, vision });
const freeUsage = {
  plan: 'free',
  percentUsed: 42,
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
        model('nvidia/nemotron-3.5-super-vl:free', 'Nemotron 3.5 Super VL'),
        model('xingchen-agi/xing4.0-29b-a4b:free', 'Xing4.0 29b A4b', false),
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
        model('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5'),
        model('openai/gpt-6-luna', 'GPT-6 Luna'),
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
        model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
        model('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5'),
      ],
    },
  ],
};
const appState: { planUsage: unknown } = { planUsage: freeUsage };
vi.mock('../src/screens/settings/parts', async (orig) => ({
  ...(await orig<object>()),
  useSave: () => save,
}));
const save = vi.fn(async () => true);
vi.mock('../src/state/app', () => ({
  useApp: () => ({
    announce,
    reportError: vi.fn(),
    reloadSettings: vi.fn(async () => {}),
    reloadPlanUsage: vi.fn(async () => {}),
    settings: { model: 'auto', plan: 'free', webSearchEnabled: true, maxToolCallsPerRun: 40 },
    info: { keychain: null },
    secrets: [],
    planUsage: appState.planUsage,
  }),
}));

const { ApprovalCard } = await import('../src/components/RunParts');
const { Composer } = await import('../src/components/Composer');
const { ModelSection } = await import('../src/screens/settings/Model');
const { PlansSection } = await import('../src/screens/settings/Info');

const wrap = (ui: ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

beforeEach(() => {
  invoke.mockReset();
  appState.planUsage = freeUsage;
});

const license = {
  plan: 'free',
  hasKey: false,
  licensingConfigured: true,
  checkoutLite: 'https://checkout.test/lite',
  checkoutPro: 'https://checkout.test/pro',
  checkedAt: null,
};

describe('ApprovalCard', () => {
  const seg = {
    kind: 'approval' as const,
    id: 'appr-1',
    callId: 'call-1',
    tier: 'write',
    native: false,
    preview: {
      title: 'Move 3 files to Documents',
      details: [['From', '~/Downloads']] as [string, string][],
      warning: null,
    },
    state: 'pending' as const,
  };

  it('calls resolve_approval with the approval id and the chosen answer', async () => {
    invoke.mockResolvedValue(true);
    wrap(<ApprovalCard seg={seg} runId="r1" />);
    expect(screen.getByText('~/Downloads')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Allow for this conversation' }));
    expect(invoke).toHaveBeenCalledWith('resolve_approval', { approvalId: 'appr-1', answer: 'conversation' });
    await userEvent.click(screen.getByRole('button', { name: 'Don’t allow' }));
    expect(invoke).toHaveBeenLastCalledWith('resolve_approval', { approvalId: 'appr-1', answer: 'deny' });
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(invoke).toHaveBeenLastCalledWith('resolve_approval', { approvalId: 'appr-1', answer: 'once' });
  });

  it('offers no conversation-wide allow for sensitive actions', () => {
    wrap(<ApprovalCard seg={{ ...seg, tier: 'sensitive' }} runId="r1" />);
    expect(screen.queryByRole('button', { name: 'Allow for this conversation' })).toBeNull();
  });

  it('sends native approvals to the system dialog with no buttons', () => {
    wrap(<ApprovalCard seg={{ ...seg, native: true }} runId="r1" />);
    expect(screen.getByText(/Confirm in the system dialog/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Composer', () => {
  it('sends on Enter with the trimmed text and clears the draft', async () => {
    const onSend = vi.fn(async () => {});
    wrap(<Composer onSend={onSend} running={false} voiceShortcut={false} />);
    const box = screen.getByRole('textbox', { name: 'Message to Lumo' });
    await userEvent.type(box, '  Tidy my desktop  ');
    await userEvent.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('Tidy my desktop', [], null);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const onSend = vi.fn(async () => {});
    wrap(<Composer onSend={onSend} running={false} voiceShortcut={false} />);
    const box = screen.getByRole('textbox', { name: 'Message to Lumo' });
    await userEvent.type(box, 'a{Shift>}{Enter}{/Shift}b');
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('a\nb');
  });

  it('keeps the draft when sending fails', async () => {
    const onSend = vi.fn(async () => {
      throw { code: 'unavailable', message: 'No model is set up.' };
    });
    wrap(<Composer onSend={onSend} running={false} voiceShortcut={false} />);
    const box = screen.getByRole('textbox', { name: 'Message to Lumo' });
    await userEvent.type(box, 'Hello{Enter}');
    expect(await screen.findByText('No model is set up.')).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('Hello');
  });

  it('shows a plan limit with an Upgrade button that opens the real checkout page', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'license_status' ? license : undefined));
    const message =
      'You’ve used all of this month’s Free usage. It resets on November 1. Upgrade to Lumo Lite or Lumo Pro in Settings → Plans for much more.';
    const onSend = vi.fn(async () => {
      throw { code: 'plan_limit', message };
    });
    wrap(<Composer onSend={onSend} running={false} voiceShortcut={false} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to Lumo' }), 'Hello{Enter}');
    expect(await screen.findByText(message)).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade to Lumo Lite' }));
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://checkout.test/lite' });
    expect(screen.getByRole('link', { name: 'Compare plans' }).getAttribute('href')).toBe('#/settings/plans');
  });

  it('nudges once 80% of this month’s usage is used', () => {
    appState.planUsage = { ...freeUsage, percentUsed: 84 };
    wrap(<Composer onSend={vi.fn()} running={false} voiceShortcut={false} />);
    expect(screen.getByText(/You’ve used 84% of this month’s usage\. It resets on/)).toBeTruthy();
  });

  it('stays quiet below 80% and when usage is unknown', () => {
    wrap(<Composer onSend={vi.fn()} running={false} voiceShortcut={false} />);
    expect(screen.queryByText(/of this month’s usage/)).toBeNull();
    appState.planUsage = { ...freeUsage, percentUsed: null, resetsAt: null, usageError: 'offline' };
    wrap(<Composer onSend={vi.fn()} running={false} voiceShortcut={false} />);
    expect(screen.queryByText(/of this month’s usage/)).toBeNull();
  });

  it('shows Stop instead of Send while a task runs', async () => {
    const onStop = vi.fn();
    wrap(<Composer onSend={vi.fn()} running onStop={onStop} voiceShortcut={false} />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stop the task' }));
    expect(onStop).toHaveBeenCalled();
  });
});

describe('ModelSection', () => {
  it('offers Auto and the plan’s models, and shows what higher plans add', async () => {
    invoke.mockResolvedValue(undefined);
    wrap(<ModelSection />);
    expect(screen.getByText(/42% of this month’s usage/)).toBeTruthy();
    expect(screen.getByText('Free models are shared')).toBeTruthy();
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(screen.getByRole('option', { name: 'Auto (Nemotron 3.5 Super VL)' })).toBeTruthy();
    expect(
      screen.getByRole('option', { name: 'Claude Sonnet 5.5 · Pro' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await userEvent.click(screen.getByRole('option', { name: 'Xing4.0 29b A4b' }));
    expect(save).toHaveBeenCalledWith({ model: 'xingchen-agi/xing4.0-29b-a4b:free' });
  });
});

describe('PlansSection', () => {
  const lic = license;
  const reply = (l: object) => async (cmd: string) => {
    if (cmd === 'license_status') return l;
    if (cmd === 'activate_license') return { ...l, plan: 'pro', hasKey: true };
    return undefined;
  };

  it('shows this month’s usage and what each plan includes', async () => {
    invoke.mockImplementation(reply(lic));
    wrap(<PlansSection />);
    expect(await screen.findByText(/42% of this month’s usage · Resets/)).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'This month’s usage' }).getAttribute('aria-valuenow'),
    ).toBe('42');
    for (const [name, price] of [
      ['Free', '$0'],
      ['Lumo Lite', '$19.99'],
      ['Lumo Pro', '$49.99'],
    ])
      expect(screen.getByRole('heading', { name }).closest('li')!.textContent).toContain(price);
    expect(screen.queryByRole('heading', { name: 'Lumo Unlimited' })).toBeNull();
    expect(screen.getByText('Models: Nemotron 3.5 Super VL and Xing4.0 29b A4b')).toBeTruthy();
    expect(screen.getByText('1 automation')).toBeTruthy();
    expect(screen.getByText('Adds Claude Haiku 5.5 and GPT-6 Luna')).toBeTruthy();
    expect(screen.getByText('10 automations')).toBeTruthy();
    expect(screen.getByText('Lumo can use your mouse and keyboard')).toBeTruthy();
    expect(screen.getByText('Adds Claude Sonnet 5.5')).toBeTruthy();
    expect(screen.getByText('Unlimited automations')).toBeTruthy();
  });

  it('says when usage can’t be read, without a bar', async () => {
    appState.planUsage = {
      ...freeUsage,
      plan: 'pro',
      percentUsed: null,
      resetsAt: null,
      usageError: 'offline',
    };
    invoke.mockImplementation(reply({ ...lic, plan: 'pro', hasKey: true }));
    wrap(<PlansSection />);
    expect(await screen.findByText('Your plan')).toBeTruthy();
    expect(screen.getByText('Usage isn’t available right now')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });

  it('opens the real checkout page and activates a key', async () => {
    invoke.mockImplementation(reply(lic));
    wrap(<PlansSection />);
    const upgrades = await screen.findAllByRole('button', { name: 'Upgrade' });
    expect(upgrades).toHaveLength(2);
    await userEvent.click(upgrades[1]!);
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://checkout.test/pro' });
    await userEvent.type(screen.getByLabelText('License key'), 'KEY-123');
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect(invoke).toHaveBeenCalledWith('activate_license', { licenseKey: 'KEY-123' });
    expect(await screen.findByText('Lumo Pro is active.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove license' })).toBeTruthy();
  });

  it('says plainly when activation is not available in this build', async () => {
    invoke.mockImplementation(
      reply({
        ...lic,
        licensingConfigured: false,
        checkoutLite: null,
        checkoutPro: null,
      }),
    );
    wrap(<PlansSection />);
    expect(await screen.findByText('License activation isn’t available in this build yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });
});
