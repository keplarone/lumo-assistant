import { routeHref } from '../lib/router';
import { AccountSection } from './settings/Account';
import { AgentsSection, MemorySection, PermissionsSection } from './settings/Data';
import { GeneralSection } from './settings/General';
import { ModelSection, VoiceSection } from './settings/Model';
import { HelpSection, PlansSection, PrivacySection } from './settings/Info';
import { AboutSection, ActivitySection, IntegrationsSection } from './settings/System';

const SECTIONS = [
  { id: 'general', label: 'General', render: () => <GeneralSection /> },
  { id: 'account', label: 'Account', render: () => <AccountSection /> },
  { id: 'model', label: 'Model', render: () => <ModelSection /> },
  { id: 'voice', label: 'Voice', render: () => <VoiceSection /> },
  { id: 'permissions', label: 'Permissions', render: () => <PermissionsSection /> },
  { id: 'memory', label: 'Memory', render: () => <MemorySection /> },
  { id: 'agents', label: 'Assistants', render: () => <AgentsSection /> },
  { id: 'integrations', label: 'Integrations', render: () => <IntegrationsSection /> },
  { id: 'activity', label: 'Activity log', render: () => <ActivitySection /> },
  { id: 'privacy', label: 'Privacy & security', render: () => <PrivacySection /> },
  { id: 'plans', label: 'Plans', render: () => <PlansSection /> },
  { id: 'help', label: 'Help', render: () => <HelpSection /> },
  { id: 'about', label: 'About', render: () => <AboutSection /> },
] as const;

export function Settings({ section }: { section: string }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="lm-settings">
      <nav className="lm-settings-nav" aria-label="Settings sections">
        <h1 className="lm-settings-nav-title">Settings</h1>
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={routeHref({ name: 'settings', section: s.id })}
                aria-current={s.id === current.id ? 'page' : undefined}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="lm-settings-body" key={current.id}>
        {current.render()}
      </div>
    </div>
  );
}
