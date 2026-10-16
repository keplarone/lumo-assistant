import { Button, Field, Input, Switch } from '@lumo/ui';
import { ArrowLeft, ArrowRight, Check, FolderPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Mascot } from '../components/Mascot';
import { api, errorMessage, type Grant } from '../lib/ipc';
import { useApp } from '../state/app';
import { mascotBus } from '../state/mascot';

// No model setup: Lumo's models work out of the box on every plan.
type Step = 'welcome' | 'you' | 'done';
const STEPS: Step[] = ['welcome', 'you', 'done'];

export function Onboarding() {
  const app = useApp();
  const [step, setStep] = useState<Step>('welcome');
  const index = STEPS.indexOf(step);

  useEffect(() => {
    if (step === 'welcome') mascotBus.send({ type: 'boot' });
    if (step === 'done') mascotBus.send({ type: 'agent', phase: 'done' });
  }, [step]);

  return (
    <main className="lm-onboarding" id="main">
      <div className="lm-onboarding-card">
        <Mascot size="hero" className="lm-onboarding-mascot" />
        <ol className="lm-steps" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li
              key={s}
              data-state={i < index ? 'done' : i === index ? 'current' : 'todo'}
              aria-current={i === index ? 'step' : undefined}
            >
              <span className="lu-visually-hidden">{`Step ${i + 1} of ${STEPS.length}`}</span>
            </li>
          ))}
        </ol>
        {step === 'welcome' && <Welcome onNext={() => setStep('you')} />}
        {step === 'you' && <YouStep onBack={() => setStep('welcome')} onNext={() => setStep('done')} />}
        {step === 'done' && (
          <div className="lm-onboarding-body">
            <h1 className="lm-onboarding-title">
              You’re all set{app.settings.userName ? `, ${app.settings.userName}` : ''}.
            </h1>
            <p className="lm-onboarding-text">
              Ask for something in your own words. Lumo shows its plan, asks before it changes anything, and
              you can stop or undo its work at any time.
            </p>
            <div className="lm-onboarding-actions">
              <Button variant="ghost" icon={<ArrowLeft />} onClick={() => setStep('you')}>
                Back
              </Button>
              <FinishButton />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function FinishButton() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      size="lg"
      loading={busy}
      autoFocus
      onClick={async () => {
        setBusy(true);
        try {
          await app.updateSettings({ onboarded: true });
        } catch (e) {
          app.reportError(e, 'Couldn’t finish setup');
          setBusy(false);
        }
      }}
    >
      Start using Lumo
    </Button>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="lm-onboarding-body">
      <h1 className="lm-onboarding-title">Hi, I’m Lumo.</h1>
      <p className="lm-onboarding-text">
        Tell me what you want done on your computer, like tidying a folder, finding a place to eat or building
        a small website, and I’ll figure out how to make it happen. You stay in charge of every change.
      </p>
      <div className="lm-onboarding-actions">
        <span />
        <Button variant="primary" size="lg" iconRight={<ArrowRight />} onClick={onNext} autoFocus>
          Get started
        </Button>
      </div>
    </div>
  );
}

function YouStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const app = useApp();
  const [name, setName] = useState(app.settings.userName ?? '');
  const [memory, setMemory] = useState(app.settings.memoryEnabled);
  const [folders, setFolders] = useState<Grant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listGrants().then(
      (g) => setFolders(g.filter((x) => x.kind === 'folder')),
      () => {},
    );
  }, []);

  const grant = async () => {
    setError(null);
    try {
      const g = await api.grantFolder();
      if (g) setFolders(await api.listGrants().then((all) => all.filter((x) => x.kind === 'folder')));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const next = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.updateSettings({ userName: name.trim() || null, memoryEnabled: memory });
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lm-onboarding-body">
      <h1 className="lm-onboarding-title">A little about you</h1>
      <Field label="What should Lumo call you?" description="Optional.">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
      </Field>
      <div className="lm-setting-row">
        <div>
          <div className="lm-setting-label">Give Lumo a folder to work in</div>
          <div className="lm-setting-desc">
            Lumo can only see and change files in folders you grant. You can add or remove folders later in
            Settings.
          </div>
          {folders.length > 0 && (
            <ul className="lm-granted">
              {folders.map((f) => (
                <li key={f.id}>
                  <Check aria-hidden /> {f.target}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button variant="secondary" icon={<FolderPlus />} onClick={() => void grant()}>
          Choose folder
        </Button>
      </div>
      <div className="lm-setting-row">
        <div>
          <div className="lm-setting-label" id="mem-label">
            Remember things between conversations
          </div>
          <div className="lm-setting-desc" id="mem-desc">
            Off by default. When on, Lumo saves only what you ask it to remember, and you can see, edit or
            delete every memory in Settings.
          </div>
        </div>
        <Switch
          checked={memory}
          onCheckedChange={setMemory}
          aria-label="Remember things between conversations"
          aria-describedby="mem-desc"
        />
      </div>
      {error && (
        <p className="lm-inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="lm-onboarding-actions">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" iconRight={<ArrowRight />} loading={busy} onClick={() => void next()}>
          Continue
        </Button>
      </div>
    </div>
  );
}
