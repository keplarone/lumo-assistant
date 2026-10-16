/**
 * First run: a swift, motion-blurred tour (each step whooshes in), then the few things Lumo needs.
 * Sign-in (owned by the accounts work) gets the first slot when it is enabled.
 */
import { Button, Callout, Field, Input, SegmentedControl, Switch } from '@lumo/ui';
import { ArrowLeft, ArrowRight, Check, ChevronDown, FolderPlus, KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Backdrop } from '../components/Backdrop';
import { LocalModels } from '../components/LocalModels';
import { LumoMark, Mascot } from '../components/Mascot';
import { PageTransition } from '../components/PageTransition';
import { signIn } from '../components/SignInSlot';
import { capabilities } from '../lib/platform';
import { api, errorMessage, type Grant, type Provider } from '../lib/ipc';
import { useApp } from '../state/app';
import { party } from '../state/companion';
import { chirp, mascotBus } from '../state/mascot';

type Step = 'signin' | 'welcome' | 'ask' | 'safe' | 'desktop' | 'model' | 'you' | 'done';
const STEPS: Step[] = [
  ...(signIn.enabled ? (['signin'] as const) : []),
  'welcome',
  'ask',
  'safe',
  ...(capabilities.desktopBuddy ? (['desktop'] as const) : []),
  'model',
  'you',
  'done',
];

export function Onboarding() {
  const app = useApp();
  const [step, setStepRaw] = useState<Step>(STEPS[0]!);
  const dir = useRef(1);
  const index = STEPS.indexOf(step);
  const setStep = (s: Step) => {
    dir.current = STEPS.indexOf(s) >= index ? 1 : -1;
    chirp('whoosh');
    setStepRaw(s);
  };
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]!);
  const back = () => setStep(STEPS[Math.max(0, index - 1)]!);

  useEffect(() => {
    if (step === 'welcome') mascotBus.send({ type: 'boot' });
    if (step === 'ask') mascotBus.send({ type: 'agent', phase: 'listening' });
    if (step === 'safe') mascotBus.send({ type: 'agent', phase: 'awaiting_approval' });
    if (step === 'desktop') {
      mascotBus.send({ type: 'agent', phase: 'idle' });
      mascotBus.act({ kind: 'celebrate' });
    }
    if (step === 'model') mascotBus.send({ type: 'agent', phase: 'thinking' });
    if (step === 'you') mascotBus.send({ type: 'react', reaction: 'love' });
    if (step === 'done') {
      mascotBus.send({ type: 'agent', phase: 'done' });
      party();
    }
  }, [step]);

  return (
    <main className="lm-onboarding" id="main">
      <Backdrop />
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
        <PageTransition routeKey={step} direction={dir.current} className="lm-onboarding-slide">
          {step === 'signin' && <signIn.Component onDone={next} />}
          {step === 'welcome' && <Welcome onNext={next} />}
          {step === 'ask' && <TourAsk onBack={back} onNext={next} />}
          {step === 'safe' && <TourSafe onBack={back} onNext={next} />}
          {step === 'desktop' && <TourDesktop onBack={back} onNext={next} />}
          {step === 'model' && <ModelStep onBack={back} onNext={next} />}
          {step === 'you' && <YouStep onBack={back} onNext={next} />}
          {step === 'done' && (
            <div className="lm-onboarding-body">
              <h1 className="lm-onboarding-title">
                You’re all set{app.settings.userName ? `, ${app.settings.userName}` : ''}.
              </h1>
              <p className="lm-onboarding-text">
                Ask me anything in your own words, or just talk. I’ll be right here, and on your desktop too.
              </p>
              <div className="lm-onboarding-actions">
                <Button variant="ghost" icon={<ArrowLeft />} onClick={back}>
                  Back
                </Button>
                <FinishButton />
              </div>
            </div>
          )}
        </PageTransition>
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
      <h1 className="lm-onboarding-title">Hi, I’m Lumo!</h1>
      <p className="lm-onboarding-text">
        Your personal AI assistant. I can chat, help you think, and get things done on your computer. Let me
        show you around. It takes about a minute.
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

function TourNav({
  onBack,
  onNext,
  label = 'Next',
}: {
  onBack: () => void;
  onNext: () => void;
  label?: string;
}) {
  return (
    <div className="lm-onboarding-actions">
      <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
        Back
      </Button>
      <Button variant="primary" size="lg" iconRight={<ArrowRight />} onClick={onNext} autoFocus>
        {label}
      </Button>
    </div>
  );
}

/** Tour 1: just ask. A little demo types itself and Lumo answers. */
function TourAsk({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <div className="lm-onboarding-body">
      <h1 className="lm-onboarding-title">Just ask, like you’d ask a friend</h1>
      <div className="lm-demo lm-demo-ask" aria-hidden="true">
        <div className="lm-demo-composer">
          <span className="lm-demo-typed">Find a cozy café near me that’s open now</span>
        </div>
        <div className="lm-demo-reply">
          <LumoMark size={22} />
          <span>Found three! The closest is a 6 minute walk…</span>
        </div>
      </div>
      <p className="lm-onboarding-text">
        Use your own words. I can also just listen when you want to talk something through.
      </p>
      <TourNav onBack={onBack} onNext={onNext} />
    </div>
  );
}

/** Tour 2: you're in charge. An approval card gets an Allow. */
function TourSafe({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <div className="lm-onboarding-body">
      <h1 className="lm-onboarding-title">You’re always in charge</h1>
      <div className="lm-demo lm-demo-safe" aria-hidden="true">
        <div className="lm-demo-card">
          <ShieldCheck />
          <div>
            <strong>Move 24 files into folders?</strong>
            <span>You can undo this later.</span>
          </div>
          <span className="lm-demo-allow">Allow</span>
        </div>
        <span className="lm-demo-cursor" />
      </div>
      <p className="lm-onboarding-text">
        I show my plan and ask before I change anything. Anything big, like sending, paying or using your
        mouse, needs your OK on your computer itself. You can stop or undo my work any time.
      </p>
      <TourNav onBack={onBack} onNext={onNext} />
    </div>
  );
}

/** Tour 3: Lumo on the desktop. The switch is the real setting. */
function TourDesktop({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const app = useApp();
  return (
    <div className="lm-onboarding-body">
      <h1 className="lm-onboarding-title">I keep you company on your desktop</h1>
      <div className="lm-demo lm-demo-desktop" aria-hidden="true">
        <div className="lm-demo-screen">
          <span className="lm-demo-window" />
          <span className="lm-demo-window lm-demo-window-2" />
          <span className="lm-demo-flyer">
            <LumoMark size={30} />
          </span>
        </div>
      </div>
      <div className="lm-setting-row">
        <div>
          <div className="lm-setting-label" id="buddy-label">
            Lumo on your desktop
          </div>
          <div className="lm-setting-desc" id="buddy-desc">
            I stay near your other apps, say hi now and then, and show you where I’m working. Click me to boop
            me, double-click to ask me something, or drag me where you like.
          </div>
        </div>
        <Switch
          checked={app.settings.buddyEnabled}
          onCheckedChange={(v) => void app.updateSettings({ buddyEnabled: v }).catch(() => {})}
          aria-labelledby="buddy-label"
          aria-describedby="buddy-desc"
        />
      </div>
      <TourNav onBack={onBack} onNext={onNext} />
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
  // The built-in model is the simple path; other providers stay out of the way until asked for.
  const [more, setMore] = useState(provider !== 'local');
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
      <h1 className="lm-onboarding-title">Give me a brain</h1>
      {!more && (
        <p className="lm-onboarding-text">
          I run on a free AI model that lives right on your computer, so your chats stay private. Download it
          once and you’re set.
        </p>
      )}
      {more && (
        <SegmentedControl<Provider>
          label="Model provider"
          value={provider}
          onValueChange={(v) => {
            setProvider(v);
            setResult(null);
          }}
          options={[
            { value: 'local', label: 'Free, on this computer' },
            { value: 'anthropic', label: 'Anthropic API key' },
            { value: 'openai_compatible', label: 'Other server' },
          ]}
        />
      )}
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
      {!more && (
        <button type="button" className="lm-more-options" onClick={() => setMore(true)}>
          <ChevronDown aria-hidden /> More options
        </button>
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
      <p className="lm-onboarding-text">
        So I can be a better companion. All of this stays on your computer.
      </p>
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
            Off by default. When on, I can remember the things that matter to you, like names, plans and what
            you like, so I don’t ask twice. You can see, edit or delete every memory in Settings.
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
