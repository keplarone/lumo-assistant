import { Button, StatusDot } from '@lumo/ui';
import { Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, on } from '../lib/ipc';
import { useApp } from '../state/app';
import { mascotBus } from '../state/mascot';
import { runStore } from '../state/runs';

/** Persistent while Lumo controls the mouse and keyboard (the `input-control` event from Rust). */
export function InputControlBanner() {
  const app = useApp();
  const [state, setState] = useState<{ active: boolean; stopShortcut: string }>({
    active: false,
    stopShortcut: 'Alt+Shift+Escape',
  });
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const sub = on('input-control', (p) => {
      setState({ active: !!p?.active, stopShortcut: p?.stopShortcut || 'Alt+Shift+Escape' });
      if (p?.active) {
        mascotBus.send({ type: 'agent', phase: 'working' });
        app.announce(
          `Lumo is using your mouse and keyboard. Press ${p.stopShortcut || 'Alt+Shift+Escape'} to take back control.`,
        );
      } else setStopping(false);
    });
    return () => void sub.then((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state.active) return null;

  const stop = async () => {
    setStopping(true);
    // The run that is controlling the computer, else every run that is still going.
    const runs = [...runStore.getSnapshot().values()].filter((r) => r.status === 'running');
    const controlling = runs.filter((r) =>
      r.segments.some(
        (s) =>
          s.kind === 'tool' &&
          s.name === 'control_computer' &&
          (s.state === 'running' || s.state === 'waiting'),
      ),
    );
    let ids = (controlling.length ? controlling : runs).map((r) => r.runId);
    try {
      if (ids.length === 0) ids = (await api.listActiveRuns()).map((r) => r.runId);
      await Promise.all(ids.map((id) => api.cancelRun(id)));
    } catch (e) {
      app.reportError(e, 'Couldn’t stop the task');
      setStopping(false);
    }
  };

  return (
    <div className="lm-control-banner" role="alert">
      <StatusDot tone="live" pulse />
      <span>
        Lumo is using your mouse and keyboard. Press <kbd>{state.stopShortcut}</kbd> or Stop to take back
        control.
      </span>
      <Button size="sm" variant="danger" icon={<Square />} loading={stopping} onClick={() => void stop()}>
        Stop
      </Button>
    </div>
  );
}
