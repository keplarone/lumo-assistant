import { Button } from '@lumo/ui';
import { Square, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { speech } from '../lib/speech';

/** Shown while a reply is being read aloud. */
export function SpeakingControl() {
  const [speaking, setSpeaking] = useState(speech.isSpeaking());
  useEffect(() => speech.subscribe(setSpeaking), []);
  if (!speaking) return null;
  return (
    <div className="lm-speaking" role="status">
      <Volume2 aria-hidden />
      <span>Reading the reply aloud</span>
      <Button size="sm" variant="ghost" icon={<Square />} onClick={() => speech.stop()}>
        Stop reading
      </Button>
    </div>
  );
}
