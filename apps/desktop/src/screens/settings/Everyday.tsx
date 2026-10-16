import { Input, SegmentedControl, Switch } from '@lumo/ui';
import { routeHref } from '../../lib/router';
import { useApp } from '../../state/app';
import { SecretField, SectionHeader, SettingRow, useSave } from './parts';

export function EverydaySection() {
  const app = useApp();
  const save = useSave();
  const s = app.settings;
  return (
    <>
      <SectionHeader
        title="My day"
        description="The morning brief, reminders, bill warnings and price watch. They run on this computer and don’t use your monthly allowance."
      />
      <SettingRow
        label="Morning brief"
        description="Weather, your calendar, reminders and bills due, each morning."
      >
        <Switch
          checked={s.briefEnabled}
          onCheckedChange={(v) => void save({ briefEnabled: v })}
          aria-label="Morning brief"
        />
      </SettingRow>
      <SettingRow
        label="Brief time"
        description="Lumo pops up with your brief at this time."
        htmlFor="brief-time"
      >
        <Input
          id="brief-time"
          type="time"
          className="lm-time-input"
          value={s.briefTime}
          disabled={!s.briefEnabled}
          onChange={(e) =>
            e.target.value && void save({ briefTime: e.target.value }, 'Couldn’t save the time')
          }
        />
      </SettingRow>
      <SettingRow
        label="Read the brief aloud"
        description="In Lumo’s voice, the first time you see it each day."
      >
        <Switch
          checked={s.briefReadAloud}
          disabled={!s.briefEnabled}
          onCheckedChange={(v) => void save({ briefReadAloud: v })}
          aria-label="Read the brief aloud"
        />
      </SettingRow>
      <SettingRow
        label="Weather"
        description={
          s.location ? (
            <>
              For {s.location.label || 'your location'}. Change it in{' '}
              <a className="lm-link" href={routeHref({ name: 'settings', section: 'general' })}>
                General
              </a>
              . Forecast data from MET Norway.
            </>
          ) : (
            <>
              Set your location in{' '}
              <a className="lm-link" href={routeHref({ name: 'settings', section: 'general' })}>
                General
              </a>{' '}
              to get the weather.
            </>
          )
        }
      >
        <SegmentedControl
          label="Temperature unit"
          value={s.temperatureUnit}
          onValueChange={(v) => void save({ temperatureUnit: v })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'celsius', label: '°C' },
            { value: 'fahrenheit', label: '°F' },
          ]}
        />
      </SettingRow>
      <SecretField
        name="calendar_ics_urls"
        label="Calendar"
        description={
          <>
            Paste your calendar’s private address (it ends in .ics). Google Calendar: Settings → your calendar
            → “Secret address in iCal format”. Outlook: Settings → Shared calendars → Publish a calendar.
            iPhone or Mac: share the calendar as a public link. Up to 5 addresses, separated by spaces. Lumo
            only reads it and keeps the address in your system keychain.
          </>
        }
      />
    </>
  );
}
