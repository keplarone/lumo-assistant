import { Button, Callout } from '@lumo/ui';
import { FileText, FolderInput, Globe, MapPin } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Composer, type ComposerHandle } from '../components/Composer';
import { rememberPendingSend } from '../components/ConversationView';
import { Mascot } from '../components/Mascot';
import { greeting } from '../lib/format';
import { api, type AttachmentInfo } from '../lib/ipc';
import { navigate } from '../lib/router';
import { useApp } from '../state/app';
import { startedHere } from '../state/runs';

/** Real prompts that work with Lumo's tools today. */
const SUGGESTIONS = [
  {
    icon: <FolderInput />,
    label: 'Organize my Downloads folder',
    prompt:
      'Organize my Downloads folder: group the files into folders by type, and show me the plan before moving anything.',
  },
  {
    icon: <MapPin />,
    label: 'Find pizza places near me',
    prompt: 'Find pizza places near me that are open now, and compare a few options.',
  },
  {
    icon: <Globe />,
    label: 'Build a one-page website for my bakery',
    prompt:
      'Build a one-page website for my bakery with a hero, our menu highlights, opening hours and a contact section. Show me the preview.',
  },
  {
    icon: <FileText />,
    label: 'Summarize a file I attach',
    prompt: 'Summarize the attached file in a few bullet points.',
    attach: true,
  },
];

export function Home() {
  const app = useApp();
  const composer = useRef<ComposerHandle>(null);
  useEffect(() => {
    const focus = () => composer.current?.focus();
    window.addEventListener('lumo:focus-composer', focus);
    return () => window.removeEventListener('lumo:focus-composer', focus);
  }, []);
  const needsKey =
    (app.settings.provider === 'anthropic' &&
      app.secrets.length > 0 &&
      !app.secrets.find((s) => s.name === 'anthropic_api_key')?.set) ||
    (app.settings.provider === 'local' && !app.settings.localModel);

  const send = async (text: string, attachments: AttachmentInfo[], agentId: string | null) => {
    const started = await api.startRun({ text, attachments: attachments.map((a) => a.token), agentId });
    startedHere.add(started.runId);
    rememberPendingSend(started.conversationId, text, attachments);
    void app.reloadConversations();
    navigate({ name: 'conversation', id: started.conversationId });
  };

  return (
    <div className="lm-home">
      <div className="lm-home-inner">
        <Mascot size="hero" className="lm-home-mascot" />
        <h1 className="lm-greeting">{greeting(app.settings.userName)}</h1>
        <p className="lm-home-sub">Tell Lumo what you want. Lumo figures out how to make it happen.</p>
        {needsKey && (
          <Callout tone="warning" title="Lumo needs a model to work" className="lm-home-callout">
            Download a free on-device model or add an Anthropic API key in Settings.{' '}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate({ name: 'settings', section: 'model' })}
            >
              Open model settings
            </Button>
          </Callout>
        )}
        <Composer ref={composer} onSend={send} running={false} agents={app.agents} acceptDrops autoFocus />
        <div className="lm-suggestions" role="list" aria-label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              role="listitem"
              className="lm-suggestion"
              onClick={() => {
                composer.current?.setText(s.prompt);
                if (s.attach) void composer.current?.attach();
              }}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
