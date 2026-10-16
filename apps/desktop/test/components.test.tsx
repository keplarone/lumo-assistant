import { TooltipProvider } from '@lumo/ui';
import { act, render, screen, waitFor } from '@testing-library/react';
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
const freeUsage = {
  plan: 'free',
  tokensUsed: 420_000,
  tokensLimit: 1_000_000,
  percentUsed: 42,
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
const appState: { planUsage: unknown } = { planUsage: freeUsage };
vi.mock('../src/state/app', () => ({
  useApp: () => ({
    announce,
    reportError: vi.fn(),
    reloadSettings: vi.fn(async () => {}),
    reloadPlanUsage: vi.fn(async () => {}),
    settings: { provider: 'local', localModel: '' },
    info: { keychain: null },
    secrets: [],
    planUsage: appState.planUsage,
  }),
}));

const { ApprovalCard } = await import('../src/components/RunParts');
const { Composer } = await import('../src/components/Composer');
const { LocalModels } = await import('../src/components/LocalModels');
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
  checkoutUnlimited: 'https://checkout.test/unlimited',
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
      'You’ve used all of this month’s Free usage. It resets on November 1. Upgrade to Lite or Pro for 30× or 150× more, or to Unlimited for no limit.';
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

  it('stays quiet below 80% and on unlimited usage', () => {
    wrap(<Composer onSend={vi.fn()} running={false} voiceShortcut={false} />);
    expect(screen.queryByText(/of this month’s usage/)).toBeNull();
    appState.planUsage = { ...freeUsage, plan: 'unlimited', tokensLimit: null, percentUsed: null };
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

describe('LocalModels', () => {
  const model = {
    id: 'qwen3:8b',
    tier: 'Nebula 4.2',
    baseModel: 'Qwen3 8B',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    sourceRepo: 'Qwen/Qwen3-8B-GGUF',
    downloadGb: 5.0,
    minMemoryGb: 16,
    summary: 'Good everyday choice.',
    displayName: 'Nebula 4.2',
    installed: false,
    partialBytes: 0,
    fits: true,
    selected: false,
    requiredPlan: null,
  };
  const status = (over: object) => ({
    brand: 'Lumo on-device models',
    engine: 'llama.cpp',
    accelerator: 'Metal',
    memoryGb: 16,
    models: [model],
    ...over,
  });

  it('runs models itself: nothing to install, downloads straight away', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'local_models_status' ? status({}) : undefined,
    );
    wrap(<LocalModels />);
    expect(await screen.findByText('Built in · uses the graphics chip (Metal)')).toBeTruthy();
    expect(screen.queryByText(/Ollama/)).toBeNull();
    const download = screen.getByRole('button', { name: 'Download' });
    expect(download).toHaveProperty('disabled', false);
    await userEvent.click(download);
    expect(invoke).toHaveBeenCalledWith('download_local_model', { id: 'qwen3:8b' });
  });

  it('offers to resume an unfinished download', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'local_models_status'
        ? status({ accelerator: 'CPU', models: [{ ...model, partialBytes: 2_000_000_000 }] })
        : undefined,
    );
    wrap(<LocalModels />);
    expect(await screen.findByText('Built in · runs on the processor')).toBeTruthy();
    expect(screen.getByText(/2\.0 GB already downloaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume download' })).toBeTruthy();
  });

  it('shows attribution, and asks before downloading a model that may not fit', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'local_models_status'
        ? status({ memoryGb: 8, models: [{ ...model, fits: false }] })
        : undefined,
    );
    wrap(<LocalModels />);
    expect(await screen.findByText('Nebula 4.2')).toBeTruthy();
    expect(screen.getByText(/Based on Qwen3 8B/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Apache-2.0' }).getAttribute('href')).toBe(model.licenseUrl);
    expect(screen.getByText('Needs 16 GB of memory; this computer has 8 GB.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(invoke).not.toHaveBeenCalledWith('download_local_model', expect.anything());
    await userEvent.click(await screen.findByRole('button', { name: 'Download anyway' }));
    expect(invoke).toHaveBeenCalledWith('download_local_model', { id: 'qwen3:8b' });
  });

  it('marks models the plan doesn’t include as Lite and offers no way to use them', async () => {
    const nova = {
      ...model,
      id: 'qwen3:30b',
      tier: 'Nova 5.5',
      displayName: 'Nova 5.5',
      requiredPlan: 'lite',
    };
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'local_models_status'
        ? status({
            models: [nova, { ...nova, id: 'gpt-oss:20b', displayName: 'Solar 5.4', installed: true }],
          })
        : undefined,
    );
    wrap(<LocalModels />);
    expect(await screen.findByText('Nova 5.5')).toBeTruthy();
    expect(screen.getAllByText('Lite')).toHaveLength(2);
    expect(screen.getAllByText(/Included with Lumo Lite and above/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use this model' })).toBeNull();
    // An installed locked model can still be deleted to free space.
    expect(screen.getByRole('button', { name: 'Delete Solar 5.4' })).toBeTruthy();
  });

  it('selects an installed model', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'local_models_status' ? status({ models: [{ ...model, installed: true }] }) : undefined,
    );
    wrap(<LocalModels />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use this model' }));
    expect(invoke).toHaveBeenCalledWith('select_local_model', { id: 'qwen3:8b' });
    await act(async () => {});
  });
});

describe('PlansSection', () => {
  const lic = license;
  const reply = (l: object) => async (cmd: string) => {
    if (cmd === 'license_status') return l;
    if (cmd === 'local_models_status') throw { code: 'unavailable', message: 'x' };
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
      ['Lumo Unlimited', '$124.99'],
    ])
      expect(screen.getByRole('heading', { name }).closest('li')!.textContent).toContain(price);
    expect(screen.getByText('On-device models: Orbit 3.8 and Nebula 4.2')).toBeTruthy();
    expect(screen.getByText('1 automation')).toBeTruthy();
    expect(screen.getByText('30× more usage than Free')).toBeTruthy();
    expect(
      screen.getByText('All on-device models: Orbit 3.8, Nebula 4.2, Solar 5.4 and Nova 5.5'),
    ).toBeTruthy();
    expect(screen.getByText('10 automations')).toBeTruthy();
    expect(screen.getByText('Lumo can use your mouse and keyboard')).toBeTruthy();
    expect(screen.getByText('150× more usage than Free')).toBeTruthy();
    expect(screen.getByText('Unlimited automations')).toBeTruthy();
    expect(screen.getByText('Unlimited usage')).toBeTruthy();
  });

  it('shows unlimited usage without a bar', async () => {
    appState.planUsage = { ...freeUsage, plan: 'unlimited', tokensLimit: null, percentUsed: null };
    invoke.mockImplementation(reply({ ...lic, plan: 'unlimited', hasKey: true }));
    wrap(<PlansSection />);
    expect(await screen.findByText('Your plan')).toBeTruthy();
    expect(screen.getAllByText('Unlimited usage').length).toBeGreaterThan(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });

  it('opens the real checkout page and activates a key', async () => {
    invoke.mockImplementation(reply(lic));
    wrap(<PlansSection />);
    const upgrades = await screen.findAllByRole('button', { name: 'Upgrade' });
    expect(upgrades).toHaveLength(3);
    await userEvent.click(upgrades[1]!);
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://checkout.test/pro' });
    await userEvent.click(upgrades[2]!);
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://checkout.test/unlimited' });
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
        checkoutUnlimited: null,
      }),
    );
    wrap(<PlansSection />);
    expect(await screen.findByText('License activation isn’t available in this build yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });
});
