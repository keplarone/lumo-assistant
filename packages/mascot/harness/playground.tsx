/**
 * Lumo playground: the R3F host with buttons for every mood, every agent phase and every one-shot.
 * Used for review and by the Playwright tests (window.__pg).
 */
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LumoMascot, type LumoMascotHandle, type LumoFrameStats } from '../src/react';
import { DEFAULT_CONFIG, MascotMachine, type AgentPhase, type MascotEvent, type MascotOutput } from '../src/behavior/machine';
import { STATES } from '../src/core/lumo';
import '../src/core/companion';

const PHASES: AgentPhase[] = ['idle', 'listening', 'thinking', 'planning', 'searching', 'working', 'typing', 'awaiting_approval', 'speaking', 'uncertain', 'done', 'failed'];

function useMachine() {
  const offset = useRef(0);
  const machine = useMemo(() => new MascotMachine(DEFAULT_CONFIG, () => performance.now() + offset.current), []);
  const [out, setOut] = useState<MascotOutput>(() => machine.send({ type: 'boot' }));
  useEffect(() => {
    const id = setInterval(() => setOut(machine.send({ type: 'tick' })), 100);
    return () => clearInterval(id);
  }, [machine]);
  return {
    out,
    phase: machine.state.phase,
    send: (e: MascotEvent) => setOut(machine.send(e)),
    /** Jump the machine's clock past the inactivity timeout. */
    fastForward: (ms: number) => { offset.current += ms; setOut(machine.send({ type: 'tick' })); },
  };
}

function Playground() {
  const m = useMachine();
  const ref = useRef<LumoMascotHandle>(null);
  const [mood, setMood] = useState<string | null>(null);
  const [calm, setCalm] = useState<boolean | undefined>(undefined);
  const [stats, setStats] = useState<LumoFrameStats | null>(null);
  const [hit, setHit] = useState<string | null>(null);
  const behavior = mood ? { ...m.out, mood } : m.out;

  useEffect(() => {
    const id = setInterval(() => ref.current && setStats(ref.current.stats()), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    (window as unknown as { __pg: object }).__pg = {
      handle: ref,
      setMood,
      send: m.send,
      fastForward: m.fastForward,
    };
  });

  const look = (name: string) => {
    const el = document.querySelector(`[data-lumo-target="${name}"]`);
    setHit(name);
    ref.current?.lookAt(el, 2500);
    setTimeout(() => setHit((h) => (h === name ? null : h)), 2500);
  };
  const phase = (p: AgentPhase) => { setMood(null); m.send({ type: 'agent', phase: p }); };

  return (
    <div className="pg">
      <header>
        <h1><i aria-hidden="true" />Lumo playground</h1>
        <div className="meta" data-lumo-target="header">three 0.186 · R3F 9 · same rig as docs/reference/lumo-mascot.html</div>
      </header>
      <div className="layout">
        <section>
          <div className="stage">
            <div className="now">mood <b data-testid="mood">{behavior.mood}</b> · phase <b>{m.phase}</b> · x <b>{behavior.locomotion.x.toFixed(2)}</b> · facing <b>{behavior.locomotion.facing}</b></div>
            <LumoMascot ref={ref} behavior={behavior} reducedMotion={calm} onPoke={() => ref.current?.celebrate()} style={{ position: 'absolute', inset: 0 }} />
          </div>
          <div className="targets">
            {['inbox', 'composer', 'approve'].map((t) => (
              <div key={t} className={'target' + (hit === t ? ' hit' : '')} data-lumo-target={t}>{t}</div>
            ))}
          </div>
        </section>
        <aside className="panel">
          <div className="group">
            <h2>Agent phase (state machine)</h2>
            <div className="btns">
              {PHASES.map((p) => (
                <button key={p} data-phase={p} aria-pressed={!mood && m.phase === p} onClick={() => phase(p)}>{p}</button>
              ))}
              <button onClick={() => m.send({ type: 'boot' })}>boot</button>
              <button onClick={() => m.fastForward(DEFAULT_CONFIG.sleepAfterMs + 10)}>fall asleep</button>
              <button onClick={() => m.send({ type: 'activity' })}>activity</button>
            </div>
          </div>
          <div className="group">
            <h2>Mood (direct)</h2>
            <div className="btns">
              {Object.keys(STATES).map((s) => (
                <button key={s} data-mood={s} aria-pressed={mood === s} onClick={() => setMood(s)}>{s}</button>
              ))}
              <button onClick={() => setMood(null)}>release</button>
            </div>
          </div>
          <div className="group">
            <h2>One-shots</h2>
            <div className="btns">
              <button onClick={() => ref.current?.blink()}>blink</button>
              <button onClick={() => ref.current?.pulse()}>pulse</button>
              <button onClick={() => ref.current?.celebrate()}>celebrate</button>
              <button onClick={() => ref.current?.wave('right')}>wave</button>
              <button onClick={() => ref.current?.turnAround()}>turn around</button>
            </div>
          </div>
          <div className="group">
            <h2>Locomotion</h2>
            <div className="btns">
              <button onClick={() => ref.current?.walkTo(-1)}>walk left</button>
              <button onClick={() => ref.current?.walkTo(0)}>walk home</button>
              <button onClick={() => ref.current?.walkTo(1)}>walk right</button>
              <button onClick={() => m.send({ type: 'move', to: 'workspace' })}>move: workspace</button>
              <button onClick={() => m.send({ type: 'move', to: 'home' })}>move: home</button>
              <button onClick={() => m.send({ type: 'face', facing: 'away' })}>face away</button>
              <button onClick={() => m.send({ type: 'face', facing: 'viewer' })}>face viewer</button>
            </div>
          </div>
          <div className="group">
            <h2>Look at</h2>
            <div className="btns">
              {['inbox', 'composer', 'approve', 'header'].map((t) => (
                <button key={t} onClick={() => look(t)}>{t}</button>
              ))}
              <button onClick={() => m.send({ type: 'attend', target: 'approve', durationMs: 2500 })}>attend (machine)</button>
            </div>
          </div>
          <div className="group">
            <label><input type="checkbox" checked={calm ?? false} onChange={(e) => setCalm(e.target.checked)} /> Reduced motion (calm)</label>
          </div>
          <div className="stats" data-testid="stats">
            {stats ? `cap ${stats.rate} fps · frames ${stats.frames} · ${stats.calls} draw calls · ${stats.triangles.toLocaleString()} tris · ${stats.geometries} geometries · ${stats.textures} textures` : '…'}
          </div>
        </aside>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
