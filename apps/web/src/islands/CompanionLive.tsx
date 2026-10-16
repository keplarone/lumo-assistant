/** Live companion mascot (lazy chunk). Shows the real behavior machine reacting to a chosen state. */
import { useEffect, useRef } from 'react';
import { LumoMascot, type LumoMascotHandle } from '@lumo/mascot/react';
import { useMascotMachine } from './useMascotMachine';

export type CompanionState = 'listening' | 'thinking' | 'working' | 'celebrating' | 'sleeping';

const AWAKE_FOREVER = 1e12;

export default function CompanionLive({ state, replay, calm, onReady }: { state: CompanionState; replay: number; calm: boolean; onReady(): void }) {
  // Sleep is entered through the machine's own idle timeout; it is effectively disabled otherwise.
  const { output, send, config } = useMascotMachine({ sleepAfterMs: AWAKE_FOREVER, celebrateMs: 3200 });
  const mascot = useRef<LumoMascotHandle>(null);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    const wait = () => {
      if (mascot.current?.lumo && ++frames > 2) onReady();
      else raf = requestAnimationFrame(wait);
    };
    raf = requestAnimationFrame(wait);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state === 'sleeping') {
      config.sleepAfterMs = 0;
      send({ type: 'agent', phase: 'idle' });
      send({ type: 'tick' });
      return;
    }
    config.sleepAfterMs = AWAKE_FOREVER;
    send({ type: 'activity' });
    if (state === 'listening') send({ type: 'agent', phase: 'listening' });
    else if (state === 'thinking') send({ type: 'agent', phase: 'thinking' });
    else if (state === 'working') send({ type: 'agent', phase: 'working' });
    else if (state === 'celebrating') send({ type: 'agent', phase: 'done' });
  }, [state, replay, send, config]);

  return (
    <LumoMascot
      ref={mascot}
      className="stage-live"
      behavior={output}
      followPointer={!calm && state !== 'sleeping'}
      fps={calm ? 30 : 60}
      framing={5.6}
      particles={calm ? 60 : 110}
      onPoke={() => send({ type: 'activity' })}
      label="Lumo"
    />
  );
}
