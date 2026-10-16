import { Badge, Button, Input } from '@lumo/ui';
import { useId, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../lib/ipc';
import { useApp } from '../../state/app';

export function SettingRow({
  label,
  description,
  children,
  htmlFor,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="lm-setting-row">
      <div>
        {htmlFor ? (
          <label className="lm-setting-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="lm-setting-label">{label}</div>
        )}
        {description && <div className="lm-setting-desc">{description}</div>}
      </div>
      <div className="lm-setting-control">{children}</div>
    </div>
  );
}

export function SectionHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="lm-settings-head">
      <h2 className="lm-settings-title">{title}</h2>
      {description && <p className="lm-page-sub">{description}</p>}
    </header>
  );
}

/**
 * A secret's presence plus set / replace / remove. The value is never shown: the field only sends a
 * new value to the keychain.
 */
export function SecretField({
  name,
  label,
  description,
  onChanged,
}: {
  name: string;
  label: string;
  description?: ReactNode;
  onChanged?: () => void;
}) {
  const app = useApp();
  const id = useId();
  const status = app.secrets.find((s) => s.name === name);
  const isSet = status?.set ?? false;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keychain = app.info.keychain;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setSecret(name, value.trim());
      setValue('');
      setEditing(false);
      await app.reloadSecrets();
      onChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSecret(name);
      await app.reloadSecrets();
      onChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lm-secret">
      <div className="lm-secret-head">
        <label className="lm-setting-label" htmlFor={id}>
          {label}
        </label>
        <Badge tone={isSet ? 'success' : 'neutral'}>{isSet ? 'Saved in keychain' : 'Not set'}</Badge>
      </div>
      {description && <div className="lm-setting-desc">{description}</div>}
      {editing || !isSet ? (
        <form
          className="lm-secret-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save();
          }}
        >
          <Input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isSet ? 'Paste a new value to replace the saved one' : 'Paste here'}
            disabled={!!keychain}
          />
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={busy}
            disabled={!value.trim() || !!keychain}
          >
            Save
          </Button>
          {isSet && (
            <Button variant="ghost" onClick={() => (setEditing(false), setValue(''))}>
              Cancel
            </Button>
          )}
        </form>
      ) : (
        <div className="lm-secret-form">
          <Button variant="secondary" onClick={() => setEditing(true)} id={id}>
            Replace
          </Button>
          <Button variant="ghost" loading={busy} onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      )}
      {error && (
        <p className="lm-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Save-on-commit text setting. */
export function useSave() {
  const app = useApp();
  return async (patch: Parameters<typeof app.updateSettings>[0], what = 'Couldn’t save the setting') => {
    try {
      await app.updateSettings(patch);
      return true;
    } catch (e) {
      app.reportError(e, what);
      return false;
    }
  };
}
