import { Button, Callout, Input, Select, Switch } from '@lumo/ui';
import { PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/ipc';
import { asPlanId, planModels, planRank, planShortName } from '../../lib/plans';
import { routeHref } from '../../lib/router';
import { useApp } from '../../state/app';
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
        A recording is made only while the microphone indicator is on. When you stop, it is sent to the
        speech-to-text service below, and only the text comes back into the message box. Nothing is sent until
        you press Enter.
      </Callout>
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
    </>
  );
}
