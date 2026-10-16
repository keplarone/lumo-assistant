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
vi.mock('../src/state/app', () => ({
  useApp: () => ({
    announce,
    reportError: vi.fn(),
    reloadSettings: vi.fn(async () => {}),
    settings: { provider: 'local', localModel: '' },
    info: { keychain: null },
    secrets: [],
  }),
}));

const { ApprovalCard } = await import('../src/components/RunParts');
const { Composer } = await import('../src/components/Composer');
const { LocalModels } = await import('../src/components/LocalModels');
const { PlansSection } = await import('../src/screens/settings/Info');

const wrap = (ui: ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

beforeEach(() => {
  invoke.mockReset();
});

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
    downloadGb: 5.2,
    minMemoryGb: 16,
    summary: 'Good everyday choice.',
    displayName: 'Nebula 4.2',
    installed: false,
    fits: true,
    selected: false,
  };
  const status = (over: object) => ({
    brand: 'Lumo on-device models',
    runtimeRunning: true,
    runtimeVersion: '0.9.0',
    runtimeDownloadUrl: 'https://ollama.com/download',
    memoryGb: 16,
    models: [model],
    otherInstalled: [],
    ...over,
  });

  it('asks for the runtime when it is not running', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'local_models_status' ? status({ runtimeRunning: false, runtimeVersion: null }) : undefined,
    );
    wrap(<LocalModels />);
    expect(await screen.findByText('On-device models need the free Ollama app')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Get Ollama' }));
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://ollama.com/download' });
    expect(screen.getByRole('button', { name: 'Download' })).toHaveProperty('disabled', true);
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
  const lic = {
    plan: 'free',
    hasKey: false,
    licensingConfigured: true,
    checkoutLite: 'https://checkout.test/lite',
    checkoutPro: 'https://checkout.test/pro',
    checkedAt: null,
  };
  const reply = (l: object) => async (cmd: string) => {
    if (cmd === 'license_status') return l;
    if (cmd === 'local_models_status') throw { code: 'unavailable', message: 'x' };
    if (cmd === 'activate_license') return { ...l, plan: 'pro', hasKey: true };
    return undefined;
  };

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
      reply({ ...lic, licensingConfigured: false, checkoutLite: null, checkoutPro: null }),
    );
    wrap(<PlansSection />);
    expect(await screen.findByText('License activation isn’t available in this build yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });
});
