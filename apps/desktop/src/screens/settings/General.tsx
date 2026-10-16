import { Button, Field, Input, SegmentedControl, Select, Switch } from '@lumo/ui';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import type { ThemeSetting } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { SectionHeader, SettingRow, useSave } from './parts';

export function GeneralSection() {
  const app = useApp();
  const save = useSave();
  const s = app.settings;
  const [name, setName] = useState(s.userName ?? '');
  const [shortcut, setShortcut] = useState(s.globalShortcut);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [loc, setLoc] = useState({
    label: s.location?.label ?? '',
    lat: s.location ? String(s.location.lat) : '',
    lon: s.location ? String(s.location.lon) : '',
  });
  const [locError, setLocError] = useState<string | null>(null);

  const saveShortcut = async () => {
    setShortcutError(null);
    try {
      await app.updateSettings({ globalShortcut: shortcut.trim() });
    } catch (e) {
      setShortcutError(
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'That shortcut can’t be used.',
      );
      setShortcut(app.settings.globalShortcut);
    }
  };

  const saveLocation = async () => {
    setLocError(null);
    const lat = Number(loc.lat);
    const lon = Number(loc.lon);
    if (!loc.label.trim()) return setLocError('Describe the place, for example a neighborhood or address.');
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || loc.lat.trim() === '')
      return setLocError('Latitude must be a number between -90 and 90.');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180 || loc.lon.trim() === '')
      return setLocError('Longitude must be a number between -180 and 180.');
    await save({ location: { label: loc.label.trim(), lat, lon } }, 'Couldn’t save the location');
  };

  const locationChanged =
    loc.label !== (s.location?.label ?? '') ||
    loc.lat !== (s.location ? String(s.location.lat) : '') ||
    loc.lon !== (s.location ? String(s.location.lon) : '');

  return (
    <>
      <SectionHeader title="General" />
      <SettingRow
        label="Your name"
        description="Lumo uses it to greet you. It is also part of new conversations’ instructions."
        htmlFor="set-name"
      >
        <form
          className="lm-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ userName: name.trim() || null });
          }}
        >
          <Input id="set-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <Button type="submit" size="md" variant="secondary" disabled={(s.userName ?? '') === name.trim()}>
            Save
          </Button>
        </form>
      </SettingRow>
      <SettingRow label="Appearance">
        <SegmentedControl<ThemeSetting>
          label="Theme"
          value={s.theme}
          onValueChange={(v) => void save({ theme: v })}
          options={[
            { value: 'system', label: 'System', icon: <Monitor /> },
            { value: 'dark', label: 'Dark', icon: <Moon /> },
            { value: 'light', label: 'Light', icon: <Sun /> },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Animated Lumo"
        description="Show Lumo in 3D. When off, a small mark takes its place."
      >
        <Switch
          checked={s.mascotEnabled}
          onCheckedChange={(v) => void save({ mascotEnabled: v })}
          aria-label="Animated Lumo"
        />
      </SettingRow>
      <SettingRow
        label="Lumo on your desktop"
        description="Lumo flies around your screen, points at what he is doing, and says hi now and then."
      >
        <Switch
          checked={s.buddyEnabled}
          onCheckedChange={(v) => void save({ buddyEnabled: v })}
          aria-label="Lumo on your desktop"
        />
      </SettingRow>
      <SettingRow
        label="Animated icon"
        description="While Lumo runs, his tray, taskbar and Dock icon blinks, flutters while he works, and waves when a reply is ready."
      >
        <Switch
          checked={s.animatedIcon}
          onCheckedChange={(v) => void save({ animatedIcon: v })}
          aria-label="Animated icon"
        />
      </SettingRow>
      <SettingRow label="Sounds" description="Little chirps and boops when Lumo reacts.">
        <Switch
          checked={s.soundsEnabled}
          onCheckedChange={(v) => void save({ soundsEnabled: v })}
          aria-label="Sounds"
        />
      </SettingRow>
      <SettingRow
        label="Reduce motion"
        description="Calmer animation everywhere, in addition to your system setting."
      >
        <Switch
          checked={s.reducedMotion}
          onCheckedChange={(v) => void save({ reducedMotion: v })}
          aria-label="Reduce motion"
        />
      </SettingRow>
      <SettingRow
        label="Quick-ask shortcut"
        description={
          shortcutError ??
          'Opens the floating Lumo window from anywhere, for example Alt+Space or CommandOrControl+Shift+L.'
        }
        htmlFor="set-shortcut"
      >
        <form
          className="lm-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveShortcut();
          }}
        >
          <Input
            id="set-shortcut"
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
            spellCheck={false}
            aria-invalid={shortcutError ? true : undefined}
          />
          <Button
            type="submit"
            size="md"
            variant="secondary"
            disabled={shortcut.trim() === s.globalShortcut || !shortcut.trim()}
          >
            Save
          </Button>
        </form>
      </SettingRow>
      <SettingRow
        label="Keep running when the window is closed"
        description="Lumo stays in the tray or menu bar so automations keep running."
      >
        <Switch
          checked={s.closeToTray}
          onCheckedChange={(v) => void save({ closeToTray: v })}
          aria-label="Keep running when the window is closed"
        />
      </SettingRow>
      <SettingRow label="Delete old conversations" description="Applied when Lumo starts.">
        <Select
          aria-label="Delete old conversations"
          value={s.retentionDays == null ? 'never' : String(s.retentionDays)}
          onValueChange={(v) => void save({ retentionDays: v === 'never' ? null : Number(v) })}
          options={[
            { value: 'never', label: 'Keep everything' },
            { value: '30', label: 'After 30 days' },
            { value: '90', label: 'After 90 days' },
            { value: '365', label: 'After a year' },
          ]}
        />
      </SettingRow>
      <div className="lm-setting-block">
        <div className="lm-setting-label">Your location</div>
        <div className="lm-setting-desc">
          Used only when you ask for places nearby. Lumo never detects it; enter it yourself. Coordinates are
          shown on most map sites when you right-click a spot.
        </div>
        <form
          className="lm-location-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveLocation();
          }}
        >
          <Field label="Place">
            <Input
              value={loc.label}
              onChange={(e) => setLoc({ ...loc, label: e.target.value })}
              placeholder="Mission District, San Francisco"
            />
          </Field>
          <Field label="Latitude">
            <Input
              inputMode="decimal"
              value={loc.lat}
              onChange={(e) => setLoc({ ...loc, lat: e.target.value })}
              placeholder="37.7599"
            />
          </Field>
          <Field label="Longitude">
            <Input
              inputMode="decimal"
              value={loc.lon}
              onChange={(e) => setLoc({ ...loc, lon: e.target.value })}
              placeholder="-122.4148"
            />
          </Field>
          <div className="lm-location-actions">
            <Button type="submit" variant="secondary" disabled={!locationChanged}>
              Save location
            </Button>
            {s.location && (
              <Button
                variant="ghost"
                onClick={async () => {
                  if (await save({ location: null })) setLoc({ label: '', lat: '', lon: '' });
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
        {locError && (
          <p className="lm-inline-error" role="alert">
            {locError}
          </p>
        )}
      </div>
    </>
  );
}
