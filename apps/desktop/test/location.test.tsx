import { TooltipProvider } from '@lumo/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn() }));

const announce = vi.fn();
const reloadSettings = vi.fn(async () => {});
vi.mock('../src/state/app', () => ({
  useApp: () => ({
    announce,
    reloadSettings,
    reportError: vi.fn(),
    updateSettings: vi.fn(async () => ({})),
    settings: {
      userName: null,
      theme: 'system',
      globalShortcut: 'Alt+Space',
      mascotEnabled: true,
      reducedMotion: false,
      closeToTray: true,
      retentionDays: null,
      location: null,
    },
  }),
}));

const { GeneralSection } = await import('../src/screens/settings/General');

const renderGeneral = () =>
  render(
    <TooltipProvider>
      <GeneralSection />
    </TooltipProvider>,
  );

beforeEach(() => {
  invoke.mockReset();
});

describe('Use my current location', () => {
  it('asks Rust for the location, then fills in the place and coordinates', async () => {
    let finish: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === 'detect_location' ? new Promise((r) => (finish = r)) : Promise.resolve(null),
    );
    renderGeneral();
    await userEvent.click(screen.getByRole('button', { name: /use my current location/i }));
    expect(invoke).toHaveBeenCalledWith('detect_location', undefined);
    // Progress while the system finds the position.
    expect(screen.getByRole('status').textContent).toMatch(/finding your location/i);
    expect(screen.getByRole('button', { name: /use my current location/i }).getAttribute('aria-busy')).toBe(
      'true',
    );

    finish({ label: 'Mission District, San Francisco', lat: 37.76, lon: -122.415 });
    await waitFor(() => expect(screen.queryByDisplayValue('Mission District, San Francisco')).not.toBeNull());
    // Coordinates stay editable.
    expect((screen.getByDisplayValue('37.76') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByDisplayValue('-122.415')).not.toBeNull();
    expect(reloadSettings).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith('Location set to Mission District, San Francisco');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the error in plain words when location is off or not allowed', async () => {
    const message =
      'Lumo isn’t allowed to use your location. Turn on Lumo under System Settings → Privacy & Security → Location Services, then try again.';
    invoke.mockRejectedValue({ code: 'denied', message });
    renderGeneral();
    await userEvent.click(screen.getByRole('button', { name: /use my current location/i }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(
      (screen.getByRole('button', { name: /use my current location/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
