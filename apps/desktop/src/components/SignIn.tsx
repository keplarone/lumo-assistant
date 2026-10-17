/**
 * The sign-in screen Lumo shows before anything else when the build has accounts. Signing in happens in
 * the default browser on Lumo's sign-in page (Google, email and password, or a passkey); this screen
 * starts it, waits, and offers a way to cancel. Rust holds the tokens; this screen never sees them.
 *
 * Self-contained so the first-run flow can place it wherever it fits; it calls `onSignedIn` when done.
 */
import { Button, Callout, Spinner } from '@lumo/ui';
import { KeyRound, Mail, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, type SignInMode } from '../lib/ipc';
import { LumoMark } from './Mascot';
import './SignIn.css';

const WAITING: Record<SignInMode, string> = {
  google: 'Finish signing in with Google in your browser.',
  email: 'Finish signing in in your browser.',
  sign_up:
    'Finish creating your account in your browser. Check your inbox if it asks you to confirm your email.',
};

function GoogleLogo() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

export function SignIn({ onSignedIn }: { onSignedIn?: () => void }) {
  const [waiting, setWaiting] = useState<SignInMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (mode: SignInMode) => {
    setError(null);
    setWaiting(mode);
    try {
      const st = await api.accountSignIn(mode);
      if (st.signedIn) onSignedIn?.();
    } catch (e) {
      // Cancelling is a choice, not an error.
      if ((e as { code?: string })?.code !== 'cancelled') setError(errorMessage(e));
    } finally {
      setWaiting(null);
    }
  };

  return (
    <main className="lm-signin" aria-labelledby="signin-title">
      <div className="lm-signin-card">
        <LumoMark size={40} />
        <h1 id="signin-title" className="lm-signin-title">
          Welcome to Lumo
        </h1>
        <p className="lm-signin-sub">
          Sign in or create a free account to start. Your plan comes with you to any computer.
        </p>

        {waiting ? (
          <div className="lm-signin-waiting" role="status" aria-live="polite">
            <Spinner label="Waiting for your browser" />
            <p>{WAITING[waiting]}</p>
            <Button variant="ghost" onClick={() => void api.accountCancelSignIn()}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="lm-signin-actions">
            <Button variant="primary" size="lg" icon={<GoogleLogo />} onClick={() => void start('google')}>
              Continue with Google
            </Button>
            <Button size="lg" icon={<Mail />} onClick={() => void start('email')}>
              Sign in with email or a passkey
            </Button>
            <Button variant="ghost" size="lg" icon={<UserPlus />} onClick={() => void start('sign_up')}>
              Create an account
            </Button>
          </div>
        )}

        {error && <Callout tone="danger">{error}</Callout>}

        <p className="lm-signin-note">
          <KeyRound aria-hidden />
          <span>
            Sign-in opens in your browser, so Lumo never sees your password. You can add a passkey and
            two-step verification for extra protection.
          </span>
        </p>
      </div>
    </main>
  );
}
