import { Button, Callout, Input, SegmentedControl, Select, Switch } from '@lumo/ui';
import { PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, type Effort, type Provider } from '../../lib/ipc';
import { LocalModels } from '../../components/LocalModels';
import { routeHref } from '../../lib/router';
import { useApp } from '../../state/app';
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

  return (
    <>
      <SectionHeader
        title="Model"
        description="The model Lumo plans and acts with. Changes apply to new conversations; existing ones keep the model they started with."
      />
      {app.info.keychain && (
        <Callout tone="danger" title="Keys can’t be saved on this computer">
          {app.info.keychain}
        </Callout>
      )}
      <SettingRow label="Provider">
        <SegmentedControl<Provider>
          label="Provider"
          value={s.provider}
          onValueChange={(v) => {
            setResult(null);
            void save({ provider: v });
          }}
          options={[
            { value: 'local', label: 'On this computer' },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'openai_compatible', label: 'Local or compatible' },
          ]}
        />
      </SettingRow>
      {app.planUsage && !app.planUsage.cloudModels && s.provider !== 'local' && (
        <Callout tone="warning" title="Your plan uses on-device models">
          Anthropic and compatible servers are included with Lumo Lite and above, so tasks won’t start with
          this provider on your plan. Choose “On this computer”, or{' '}
          <a className="lm-link" href={routeHref({ name: 'settings', section: 'plans' })}>
            see plans
          </a>
          .
        </Callout>
      )}
      {s.provider === 'local' ? (
        <div className="lm-setting-block lm-local-block">
          <LocalModels onSelected={() => setResult(null)} />
        </div>
      ) : s.provider === 'anthropic' ? (
        <>
          <SettingRow label="Model">
            <Select
              aria-label="Model"
              value={s.model}
              onValueChange={(v) => void save({ model: v })}
              options={app.info.models.map(([id, label]) => ({ value: id, label }))}
            />
          </SettingRow>
          <SettingRow
            label="Effort"
            description="How much the model thinks before acting. Higher is slower and costs more, and helps with complex tasks."
          >
            <SegmentedControl<Effort>
              label="Effort"
              value={s.effort}
              onValueChange={(v) => void save({ effort: v })}
              options={[
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'Max' },
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Web search"
            description="Let the model search the web and read pages (Anthropic’s built-in tools)."
          >
            <Switch
              checked={s.webSearchEnabled}
              onCheckedChange={(v) => void save({ webSearchEnabled: v })}
              aria-label="Web search"
            />
          </SettingRow>
          <SecretField
            name="anthropic_api_key"
            label="Anthropic API key"
            description="Stored in your system keychain. It is never shown again, and only Lumo’s core uses it to call Anthropic."
            onChanged={() => setResult(null)}
          />
          <SettingRow
            label="API address"
            description="Change only if you use a gateway. Must be https."
            htmlFor="anthropic-url"
          >
            <TextSetting
              id="anthropic-url"
              value={s.anthropicBaseUrl}
              inputMode="url"
              onSave={(v) => save({ anthropicBaseUrl: v }, 'Couldn’t save the address')}
            />
          </SettingRow>
        </>
      ) : (
        <>
          <SettingRow
            label="Server address"
            description="A model server you run yourself, for example http://localhost:1234/v1 (LM Studio) or http://localhost:11434/v1 (Ollama). Remote servers must use https."
            htmlFor="openai-url"
          >
            <TextSetting
              id="openai-url"
              value={s.openaiBaseUrl}
              inputMode="url"
              onSave={(v) => save({ openaiBaseUrl: v }, 'Couldn’t save the address')}
            />
          </SettingRow>
          <SettingRow
            label="Model name"
            description="As your server lists it. Pick a model that supports tool use."
            htmlFor="openai-model"
          >
            <TextSetting
              id="openai-model"
              value={s.openaiModel}
              onSave={(v) => save({ openaiModel: v }, 'Couldn’t save the model')}
            />
          </SettingRow>
          <SecretField
            name="openai_compatible_api_key"
            label="API key (optional)"
            description="Only if your server needs one. Stored in your system keychain and never shown again."
          />
        </>
      )}
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
            {result.ok
              ? s.provider === 'local'
                ? result.text
                : `Lumo reached ${s.provider === 'anthropic' ? 'Anthropic' : s.openaiBaseUrl}.`
              : result.text}
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
