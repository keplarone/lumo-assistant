import { Button, Callout, Input, ProgressBar, SegmentedControl, Select, Switch } from '@lumo/ui';
import { PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatBytes } from '../../lib/format';
import {
  api,
  errorMessage,
  isApiError,
  on,
  type SpeechModelProgress,
  type SpeechModelStatus,
} from '../../lib/ipc';
import { asPlanId, planModels, planRank, planShortName } from '../../lib/plans';
import { routeHref } from '../../lib/router';
import { speech } from '../../lib/speech';
import { useApp } from '../../state/app';
import { captureWakeSample } from '../../state/useWakeWord';
import { UsageMeter } from './Info';
import { SecretField, SectionHeader, SettingRow, useSave } from './parts';

function TextSetting({
  id,
  value,
  onSave,
  placeholder,
  inputMode,
  className,
}: {
  id: string;
  value: string;
  onSave: (v: string) => Promise<boolean>;
  placeholder?: string;
  inputMode?: 'numeric' | 'url';
  className?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <form
      className="lm-inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!(await onSave(v.trim()))) setV(value);
      }}
    >
      <Input
        id={id}
        value={v}
        onChange={(e) => setV(e.target.value)}
        spellCheck={false}
        placeholder={placeholder}
        inputMode={inputMode}
        className={className}
      />
      <Button type="submit" variant="secondary" disabled={v.trim() === value || !v.trim()}>
        Save
      </Button>
    </form>
  );
}

export function ModelSection() {
  const app = useApp();
  const save = useSave();
  const s = app.settings;
  const usage = app.planUsage;
  const plan = asPlanId(usage?.plan ?? s.plan);
  const plans = usage?.plans ?? [];
  const { auto, models } = planModels(plans, plan);
  const higher = plans.filter((p) => planRank(p.id) > planRank(plan));
  const included = new Set(models.map((m) => m.id));
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult({ ok: true, text: await api.testModelConnection() });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  // The plan's models, then (disabled) the ones a higher plan adds, so people can see what they'd get.
  const options: { value: string; label: string; disabled?: boolean }[] = [
    { value: 'auto', label: auto ? `Auto (${auto.name})` : 'Auto' },
    ...models.map((m) => ({ value: m.id, label: m.name })),
    ...higher.flatMap((p) =>
      p.models
        .filter((m) => !included.has(m.id) && (included.add(m.id), true))
        .map((m) => ({ value: m.id, label: `${m.name} · ${planShortName(p.id)}`, disabled: true })),
    ),
  ];
  const chosen = models.find((m) => m.id === s.model) ?? (s.model === 'auto' ? auto : null);

  return (
    <>
      <SectionHeader
        title="Model"
        description="The AI model Lumo plans and acts with. Changes apply to new conversations."
      />
      {usage && <UsageMeter usage={usage} />}
      <SettingRow
        label="Model"
        description={chosen?.blurb || 'Auto picks a good model from your plan for you.'}
      >
        <Select
          aria-label="Model"
          value={options.some((o) => o.value === s.model && !o.disabled) ? s.model : 'auto'}
          onValueChange={(v) => {
            setResult(null);
            void save({ model: v });
          }}
          options={options}
        />
      </SettingRow>
      {chosen && !chosen.vision && (
        <Callout tone="neutral" title="This model can’t see images">
          Lumo won’t take screenshots or use your screen with it. Pick another model for tasks on your screen.
        </Callout>
      )}
      {plan === 'free' && (
        <Callout tone="neutral" title="Free models are shared">
          Everyone on Free shares them, so they can be slow or busy at peak times. Lumo Lite and Lumo Pro use
          faster, smarter models.{' '}
          <a className="lm-link" href={routeHref({ name: 'settings', section: 'plans' })}>
            See plans
          </a>
        </Callout>
      )}
      <SettingRow
        label="Web search"
        description="Let Lumo search the web. Needs a Brave Search key, added under Integrations."
      >
        <Switch
          checked={s.webSearchEnabled}
          onCheckedChange={(v) => void save({ webSearchEnabled: v })}
          aria-label="Web search"
        />
      </SettingRow>
      <SettingRow
        label="Most actions per task"
        description="Lumo stops and reports progress when a task reaches this many tool calls (1 to 200)."
        htmlFor="max-calls"
      >
        <TextSetting
          id="max-calls"
          className="lm-number-input"
          inputMode="numeric"
          value={String(s.maxToolCallsPerRun)}
          onSave={async (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1 || n > 200) {
              app.reportError(
                { code: 'invalid', message: 'Enter a whole number from 1 to 200.' },
                'Couldn’t save',
              );
              return false;
            }
            return save({ maxToolCallsPerRun: n });
          }}
        />
      </SettingRow>
      <div className="lm-setting-block">
        <Button variant="secondary" icon={<PlugZap />} loading={testing} onClick={() => void test()}>
          Test connection
        </Button>
        {result && (
          <Callout
            tone={result.ok ? 'success' : 'danger'}
            title={result.ok ? 'Connected' : 'Couldn’t connect'}
          >
            {result.text}
          </Callout>
        )}
      </div>
    </>
  );
}

export function VoiceSection() {
  const app = useApp();
  const save = useSave();
  const s = app.settings;
  const speechAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  return (
    <>
      <SectionHeader
        title="Voice"
        description="Talk to Lumo with the microphone button in the message box: click for hands-free (it stops when you pause), or hold it, or hold Ctrl/⌘+Shift+Space."
      />
      <Callout tone="neutral" title="Where your voice goes">
        {s.sttEngine === 'device'
          ? 'A recording is made only while the microphone indicator is on. Lumo turns it into text on this computer; the recording never leaves it. Nothing is sent until you press Enter.'
          : 'A recording is made only while the microphone indicator is on. When you stop, it is sent to the speech-to-text service below, and only the text comes back into the message box. Nothing is sent until you press Enter.'}
      </Callout>
      <SettingRow
        label="Speech recognition"
        description="On this computer is free and private. A service can be faster on older computers."
      >
        <SegmentedControl
          label="Speech recognition"
          value={s.sttEngine}
          onValueChange={(v) => void save({ sttEngine: v })}
          options={[
            { value: 'device', label: 'On this computer' },
            { value: 'service', label: 'A service' },
          ]}
        />
      </SettingRow>
      {s.sttEngine === 'device' ? (
        <SpeechModelSetting />
      ) : (
        <>
          <SettingRow
            label="Speech-to-text address"
            description="An OpenAI-compatible transcription endpoint, for example https://api.openai.com/v1, or a local server such as http://localhost:8000/v1."
            htmlFor="stt-url"
          >
            <TextSetting
              id="stt-url"
              value={s.sttBaseUrl}
              inputMode="url"
              onSave={(v) => save({ sttBaseUrl: v }, 'Couldn’t save the address')}
            />
          </SettingRow>
          <SettingRow label="Transcription model" htmlFor="stt-model">
            <TextSetting
              id="stt-model"
              value={s.sttModel}
              onSave={(v) => save({ sttModel: v }, 'Couldn’t save the model')}
            />
          </SettingRow>
          <SecretField
            name="stt_api_key"
            label="Speech-to-text API key"
            description="Not needed for local servers. Stored in your system keychain and never shown again."
          />
        </>
      )}
      <SettingRow
        label="Read replies aloud"
        description={
          speechAvailable
            ? 'Uses your computer’s own voices; nothing leaves the device. A Stop button appears while Lumo reads.'
            : 'Your system doesn’t offer text-to-speech in this window.'
        }
      >
        <Switch
          checked={s.ttsEnabled}
          disabled={!speechAvailable}
          onCheckedChange={(v) => void save({ ttsEnabled: v })}
          aria-label="Read replies aloud"
        />
      </SettingRow>
      <SettingRow
        label="Lumo’s voice"
        description="“Lumo” is a light, bouncy voice that fits the mascot. Both use voices already on your computer, so they’re free and private."
      >
        <div className="lm-row-actions">
          <Select
            aria-label="Lumo’s voice"
            className="lm-voice-select"
            value={s.voiceStyle}
            onValueChange={(v) => void save({ voiceStyle: v as typeof s.voiceStyle })}
            options={[
              { value: 'lumo', label: 'Lumo' },
              { value: 'system', label: 'System default' },
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!speechAvailable}
            onClick={() => speech.speak('Hi! I’m Lumo. What can I do for you today?')}
          >
            Try it
          </Button>
        </div>
      </SettingRow>
      <WakeWordSetting />
    </>
  );
}

/** "Hey Lumo": the toggle plus recording the three samples the on-device matcher compares against. */
function WakeWordSetting() {
  const app = useApp();
  const save = useSave();
  const s = app.settings;
  const [samples, setSamples] = useState<number[][][] | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getWakeTemplates().then(setSamples, () => setSamples([]));
  }, []);

  const record = async () => {
    setError(null);
    const taken: number[][][] = [];
    try {
      for (let i = 0; i < 3; i++) {
        setRecording(i + 1);
        const sample = await captureWakeSample();
        if (!sample || sample.length < 20) {
          setError('I didn’t catch that. Say “Hey Lumo” clearly after pressing the button, then pause.');
          return;
        }
        taken.push(sample);
      }
      await api.saveWakeTemplates(taken);
      setSamples(taken);
      window.dispatchEvent(new Event('lumo:wake-samples-changed'));
      if (!s.wakeWordEnabled) await save({ wakeWordEnabled: true });
      app.announce('“Hey Lumo” is set up.');
      // Hands-free requests need the speech model; fetch it now rather than at the first request.
      const model = await api.speechModelStatus().catch(() => null);
      if (s.sttEngine === 'device' && model && !model.installed && !model.downloading)
        void api.downloadSpeechModel().catch(() => {});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRecording(null);
    }
  };

  const ready = (samples?.length ?? 0) >= 3;
  return (
    <SettingRow
      label="“Hey Lumo”"
      description={
        <>
          Say “Hey Lumo” and then your request, without touching anything. Lumo learns your voice from three
          short recordings. Listening for the phrase happens only on this computer; after it hears it, your
          request is transcribed like any other voice message and the reply is read aloud.
          {recording !== null && (
            <span className="lm-inline-ok"> Say “Hey Lumo” now ({recording} of 3)…</span>
          )}
          {error && <span className="lm-inline-error"> {error}</span>}
        </>
      }
    >
      <div className="lm-row-actions">
        <Button size="sm" variant="secondary" loading={recording !== null} onClick={() => void record()}>
          {ready ? 'Record again' : 'Set up'}
        </Button>
        <Switch
          checked={s.wakeWordEnabled && ready}
          disabled={!ready}
          onCheckedChange={(v) => void save({ wakeWordEnabled: v })}
          aria-label="Listen for Hey Lumo"
        />
      </div>
    </SettingRow>
  );
}

/** Lumo's on-device speech model: download (with progress), cancel, or remove. */
export function SpeechModelSetting() {
  const app = useApp();
  const [status, setStatus] = useState<SpeechModelStatus | null>(null);
  const [progress, setProgress] = useState<SpeechModelProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => api.speechModelStatus().then(setStatus, () => setStatus(null));
  useEffect(() => {
    void reload();
    const sub = on('speech-model-progress', (p) => {
      setProgress(p.done ? null : p);
      if (p.done) void reload();
    });
    return () => void sub.then((u) => u());
  }, []);

  const download = async () => {
    setError(null);
    setStatus((st) => (st ? { ...st, downloading: true } : st));
    try {
      await api.downloadSpeechModel();
      app.announce('The speech model is ready.');
    } catch (e) {
      if (!(isApiError(e) && e.code === 'cancelled')) setError(errorMessage(e));
    } finally {
      void reload();
    }
  };
  const remove = async () => {
    try {
      await api.deleteSpeechModel();
      void reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const size = status ? formatBytes(status.sizeBytes) : '';
  const busy = !!status?.downloading || !!progress;
  return (
    <SettingRow
      label="Speech model"
      description={
        <>
          {status?.installed
            ? `Ready. ${status.name}, ${status.license} license, ${size} on this computer.`
            : `Download once (${size || 'about 290 MB'}) and voice input works without any key or internet.`}
          {progress && progress.total > 0 && (
            <ProgressBar
              className="lm-speech-progress"
              value={progress.completed / progress.total}
              label={`Downloading the speech model: ${formatBytes(progress.completed)} of ${formatBytes(progress.total)}`}
            />
          )}
          {error && <span className="lm-inline-error"> {error}</span>}
        </>
      }
    >
      {status?.installed ? (
        <Button size="sm" variant="ghost" onClick={() => void remove()}>
          Remove
        </Button>
      ) : busy ? (
        <Button size="sm" variant="ghost" onClick={() => void api.cancelSpeechModelDownload()}>
          Cancel
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={() => void download()}>
          Download
        </Button>
      )}
    </SettingRow>
  );
}
