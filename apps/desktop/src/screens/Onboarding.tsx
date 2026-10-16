import { Button, Callout, Field, Input, SegmentedControl, Switch } from '@lumo/ui';
import { ArrowLeft, ArrowRight, Check, FolderPlus, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LocalModels } from '../components/LocalModels';
import { Mascot } from '../components/Mascot';
import { api, errorMessage, type Grant, type Provider } from '../lib/ipc';
import { useApp } from '../state/app';
import { mascotBus } from '../state/mascot';

type Step = 'welcome' | 'model' | 'you' | 'done';
const STEPS: Step[] = ['welcome', 'model', 'you', 'done'];

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
        {step === 'welcome' && <Welcome onNext={() => setStep('model')} />}
        {step === 'model' && <ModelStep onBack={() => setStep('welcome')} onNext={() => setStep('you')} />}
        {step === 'you' && <YouStep onBack={() => setStep('model')} onNext={() => setStep('done')} />}
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

function ModelStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const app = useApp();
  const anthropicKeySet = app.secrets.find((s) => s.name === 'anthropic_api_key')?.set ?? false;
  // The free on-device path is the default unless the user already set up another provider.
  const [provider, setProvider] = useState<Provider>(
    app.settings.provider === 'anthropic' && !anthropicKeySet ? 'local' : app.settings.provider,
  );
  const localReady = app.settings.provider === 'local' && !!app.settings.localModel;
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(app.settings.openaiBaseUrl);
  const [model, setModel] = useState(app.settings.openaiModel);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const keychainError = app.info.keychain;
  const keySaved =
    app.secrets.find(
      (s) => s.name === (provider === 'anthropic' ? 'anthropic_api_key' : 'openai_compatible_api_key'),
    )?.set ?? false;

  const saveAndTest = async () => {
    setBusy(true);
    setResult(null);
    try {
      if (provider === 'anthropic') {
        if (key.trim()) await api.setSecret('anthropic_api_key', key.trim());
        await app.updateSettings({ provider: 'anthropic' });
      } else {
        if (key.trim()) await api.setSecret('openai_compatible_api_key', key.trim());
        await app.updateSettings({
          provider: 'openai_compatible',
          openaiBaseUrl: baseUrl.trim(),
          openaiModel: model.trim(),
        });
      }
      setKey('');
      await app.reloadSecrets();
      const msg = await api.testModelConnection();
      setResult({ ok: true, text: msg });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const canTest = provider === 'anthropic' ? !!key.trim() || keySaved : !!baseUrl.trim() && !!model.trim();

  return (
    <div className="lm-onboarding-body">
      <h1 className="lm-onboarding-title">Choose the model Lumo thinks with</h1>
      <SegmentedControl<Provider>
        label="Model provider"
        value={provider}
        onValueChange={(v) => {
          setProvider(v);
          setResult(null);
        }}
        options={[
          { value: 'local', label: 'Free, on this computer' },
          { value: 'anthropic', label: 'Add an Anthropic API key' },
          { value: 'openai_compatible', label: 'Other server' },
        ]}
      />
      {keychainError && (
        <Callout tone="danger" title="Keys can’t be saved on this computer">
          {keychainError}
        </Callout>
      )}
      {provider === 'local' ? (
        <LocalModels
          variant="onboarding"
          onSelected={(m) => setResult({ ok: true, text: `${m.displayName} is ready.` })}
        />
      ) : provider === 'anthropic' ? (
        <Field
          label="Anthropic API key"
          description={
            keySaved
              ? 'A key is saved. Paste a new one only to replace it.'
              : 'Create one at console.anthropic.com. It is stored in your system keychain and never shown again, not even to Lumo’s interface.'
          }
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={keySaved ? '••••••••  (saved)' : 'sk-ant-…'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={!!keychainError}
          />
        </Field>
      ) : (
        <>
          <Field
            label="Server address"
            description="A model server you run yourself, for example LM Studio at http://localhost:1234/v1 or Ollama at http://localhost:11434/v1. Remote servers must use https."
          >
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
          </Field>
          <Field
            label="Model name"
            description="As your server lists it. Lumo works best with models that support tool use."
          >
            <Input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
          </Field>
          <Field
            label="API key (optional)"
            description="Only if your server needs one. Stored in your system keychain and never shown again."
          >
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={keySaved ? '••••••••  (saved)' : ''}
              disabled={!!keychainError}
            />
          </Field>
        </>
      )}
      {result && provider !== 'local' && (
        <Callout tone={result.ok ? 'success' : 'danger'} title={result.ok ? 'Connected' : 'Couldn’t connect'}>
          {result.ok ? 'Lumo reached the model provider.' : result.text}
        </Callout>
      )}
      <div className="lm-onboarding-actions">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          Back
        </Button>
        <div className="lm-row-actions">
          {provider !== 'local' && (
            <Button
              variant="secondary"
              icon={<KeyRound />}
              loading={busy}
              disabled={!canTest}
              onClick={() => void saveAndTest()}
            >
              Save and test
            </Button>
          )}
          {(() => {
            const ready = provider === 'local' ? localReady : !!result?.ok;
            return (
              <Button variant={ready ? 'primary' : 'ghost'} iconRight={<ArrowRight />} onClick={onNext}>
                {ready ? 'Continue' : 'Skip for now'}
              </Button>
            );
          })()}
        </div>
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
