/**
 * The first-run sign-in slot. The accounts work owns sign-in (Google or an email account, with
 * passkeys recommended); it replaces this file with its own screen and sets `enabled` to true.
 * Until then the step is skipped. The screen sits inside the onboarding card and gets onDone to move on.
 */
import type { ComponentType } from 'react';

export interface SignInStepProps {
  onDone: () => void;
}

export const signIn: { enabled: boolean; Component: ComponentType<SignInStepProps> } = {
  enabled: false,
  Component: () => null,
};
