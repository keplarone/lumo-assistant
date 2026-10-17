import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn() }));

const { SignIn } = await import('../src/components/SignIn');

const signedIn = {
  configured: true,
  signedIn: true,
  signingIn: false,
  account: null,
  recommendPasskey: true,
  recommendTwoStep: true,
};

describe('SignIn', () => {
  it('signs in with Google in the browser and reports back', async () => {
    let finish: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === 'account_sign_in' ? new Promise((r) => (finish = r)) : Promise.resolve(null),
    );
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(invoke).toHaveBeenCalledWith('account_sign_in', { mode: 'google' });
    expect(screen.getByText('Finish signing in with Google in your browser.')).toBeTruthy();
    finish(signedIn);
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it('can cancel, and a cancelled sign-in is not an error', async () => {
    let fail: (e: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === 'account_sign_in' ? new Promise((_, r) => (fail = r)) : Promise.resolve(null),
    );
    render(<SignIn />);
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(invoke).toHaveBeenCalledWith('account_sign_in', { mode: 'sign_up' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(invoke).toHaveBeenCalledWith('account_cancel_sign_in', undefined);
    fail({ code: 'cancelled', message: 'cancelled' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in with email or a passkey' })).toBeTruthy(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows why a sign-in failed', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'account_sign_in'
        ? Promise.reject({ code: 'unavailable', message: 'Could not reach the sign-in service.' })
        : Promise.resolve(null),
    );
    render(<SignIn />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with email or a passkey' }));
    expect(await screen.findByText('Could not reach the sign-in service.')).toBeTruthy();
  });
});
