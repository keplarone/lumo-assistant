import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CONFIG, MascotMachine, type MascotConfig, type MascotEvent, type MascotOutput } from '@lumo/mascot';

// The output is a small plain object whose fields grow as the mascot package evolves; compare it whole.
const same = (a: MascotOutput, b: MascotOutput) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Owns a MascotMachine for one island: ticks it a few times a second so transient moods expire,
 * and re-renders only when the output actually changes.
 */
export function useMascotMachine(config: Partial<MascotConfig> = {}) {
  const cfgRef = useRef<MascotConfig>({ ...DEFAULT_CONFIG, ...config });
  const machineRef = useRef<MascotMachine | null>(null);
  if (!machineRef.current) machineRef.current = new MascotMachine(cfgRef.current);
  const [out, setOut] = useState<MascotOutput>(() => machineRef.current!.output);

  const send = useCallback((e: MascotEvent) => {
    const next = machineRef.current!.send(e);
    setOut((prev) => (same(prev, next) ? prev : next));
    return next;
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => send({ type: 'tick' }), 200);
    return () => window.clearInterval(id);
  }, [send]);

  return { output: out, send, config: cfgRef.current };
}
