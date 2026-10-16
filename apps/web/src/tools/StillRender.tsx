/** Dev-only: renders one mascot mood on a transparent canvas for scripts/render-stills.mjs. */
import { useEffect, useState } from 'react';
import { MascotMachine } from '@lumo/mascot';
import { LumoMascot } from '@lumo/mascot/react';

export default function StillRender() {
  const [params] = useState(() => new URLSearchParams(location.search));
  const mood = params.get('mood') ?? 'idle';
  const framing = Number(params.get('framing') ?? '5.2');
  const gx = params.get('gx');
  const gy = params.get('gy');
  const gaze = gx !== null && gy !== null ? { x: Number(gx), y: Number(gy) } : null;
  useEffect(() => {
    const t = setTimeout(
      () => document.documentElement.setAttribute('data-ready', '1'),
      Number(params.get('wait') ?? '2600'),
    );
    return () => clearTimeout(t);
  }, [params]);
  return (
    <LumoMascot
      // Start from the machine's own output so new fields keep their defaults; override mood and gaze.
      behavior={{ ...new MascotMachine().output, mood, gaze }}
      followPointer={false}
      framing={framing}
      particles={Number(params.get('particles') ?? '150')}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
