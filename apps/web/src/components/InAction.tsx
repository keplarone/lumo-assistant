/**
 * "See Lumo in Action": a step-by-step walkthrough built from the real @lumo/ui components.
 *
 * This is a placeholder for the interactive desktop preview. When the app UI ships, replace the body
 * of this component (keep the export name and the `id` on the section in index.astro) with the
 * embedded desktop UI.
 *
 * Server render shows the whole transcript, so it reads completely without JavaScript. In the
 * browser, the step controls appear and the walkthrough can be replayed one step at a time.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Callout, Card, Kbd, ProgressBar, StatusDot } from '@lumo/ui';
import { ArrowLeft, ArrowRight, Check, FolderOpen, RotateCcw, ShieldCheck } from 'lucide-react';

interface Step {
  title: string;
  phase: string;
  render(): ReactNode;
}

const PLAN = [
  'Look through ~/Downloads (granted folder, read only)',
  'Group files by type and age',
  'Ask before moving anything',
  'Move, then check every file arrived',
];

const MOVES = [
  ['Installers', '.dmg, .msi, .exe older than 30 days', '41'],
  ['Documents', '.pdf, .docx, .txt', '63'],
  ['Images', '.png, .jpg, .heic', '52'],
  ['Archives', '.zip, .tar.gz', '26'],
];

const STEPS: Step[] = [
  {
    title: 'You ask',
    phase: 'Request',
    render: () => (
      <div className="ia-msg ia-user">
        <p>Tidy up my Downloads folder. Sort things by type and put old installers in one place.</p>
      </div>
    ),
  },
  {
    title: 'Lumo plans',
    phase: 'Understanding and planning',
    render: () => (
      <Card className="ia-card">
        <div className="ia-card-head">
          <span className="ia-card-title">Plan</span>
          <Badge tone="accent">4 steps</Badge>
        </div>
        <ol className="ia-plan">
          {PLAN.map((p, i) => (
            <li key={p} data-done={i < 1 || undefined}>
              <span className="ia-plan-mark" aria-hidden>
                {i < 1 ? <Check /> : i + 1}
              </span>
              {p}
            </li>
          ))}
        </ol>
        <ProgressBar value={0.25} label="Plan progress" />
      </Card>
    ),
  },
  {
    title: 'Reads, automatically',
    phase: 'Using tools (read tier)',
    render: () => (
      <div className="ia-tool">
        <FolderOpen aria-hidden />
        <span>
          <strong>list_directory</strong> ~/Downloads
        </span>
        <Badge tone="neutral">Read · no approval needed</Badge>
        <span className="ia-tool-result">182 files found</span>
      </div>
    ),
  },
  {
    title: 'Asks before changing',
    phase: 'Approval (write tier)',
    render: () => (
      <Card className="ia-card ia-approval">
        <div className="ia-card-head">
          <span className="ia-card-title">Move 182 files into 4 folders?</span>
          <Badge tone="warning">Needs your approval</Badge>
        </div>
        <table className="ia-table">
          <caption className="sr-only">Proposed moves</caption>
          <thead>
            <tr>
              <th scope="col">Folder</th>
              <th scope="col">What goes there</th>
              <th scope="col">Files</th>
            </tr>
          </thead>
          <tbody>
            {MOVES.map(([a, b, c]) => (
              <tr key={a}>
                <td>{a}</td>
                <td>{b}</td>
                <td>{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ia-fine">Nothing is deleted. Every move is journaled and can be undone.</p>
        <div className="ia-actions">
          <Button variant="primary" size="sm" tabIndex={-1} aria-hidden>
            Approve
          </Button>
          <Button variant="secondary" size="sm" tabIndex={-1} aria-hidden>
            Not now
          </Button>
        </div>
      </Card>
    ),
  },
  {
    title: 'Checks and reports',
    phase: 'Verifying and reporting',
    render: () => (
      <div className="ia-msg ia-lumo">
        <div className="ia-lumo-head">
          <StatusDot tone="lumen" />
          <span>Lumo</span>
        </div>
        <p>
          Done. I moved 182 files into Installers, Documents, Images and Archives, then checked that each one arrived. Nothing was deleted. You can
          undo the whole change from the history.
        </p>
        <Callout tone="success" title="Verified">
          182 of 182 files are in their new folders.
        </Callout>
      </div>
    ),
  },
];

export default function InAction() {
  const [mounted, setMounted] = useState(false);
  // Server render (and the hydration pass) shows the full transcript.
  const [step, setStep] = useState(STEPS.length - 1);
  useEffect(() => setMounted(true), []);

  const last = STEPS.length - 1;
  const current = STEPS[step]!;

  return (
    <div className="ia">
      <div className="ia-window" aria-label="Lumo conversation, sample walkthrough" role="group">
        <div className="ia-titlebar">
          <span className="ia-titlebar-name">Lumo</span>
          <span className="ia-titlebar-hint">
            <Kbd keys={['Alt', 'Space']} /> <span className="sr-only">opens the floating assistant</span>
          </span>
        </div>
        <ol className="ia-transcript">
          {STEPS.slice(0, step + 1).map((s, i) => (
            <li key={s.title} className="ia-step" data-current={mounted && i === step ? '' : undefined}>
              <span className="ia-phase">
                {i + 1}. {s.phase}
              </span>
              {s.render()}
            </li>
          ))}
        </ol>
        <div className="ia-composer" aria-hidden>
          <span>Ask Lumo anything…</span>
          <ShieldCheck />
        </div>
      </div>

      <div className="ia-side">
        <ol className="ia-steps" aria-label="Walkthrough steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              {mounted ? (
                <button type="button" className="ia-step-link" aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>
                  <span className="ia-step-num">{i + 1}</span>
                  {s.title}
                </button>
              ) : (
                <span className="ia-step-link">
                  <span className="ia-step-num">{i + 1}</span>
                  {s.title}
                </span>
              )}
            </li>
          ))}
        </ol>
        {mounted && (
          <div className="ia-controls">
            <Button size="sm" variant="secondary" icon={<ArrowLeft />} disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
              Back
            </Button>
            {step < last ? (
              <Button size="sm" variant="primary" iconRight={<ArrowRight />} onClick={() => setStep((s) => Math.min(last, s + 1))}>
                Next
              </Button>
            ) : (
              <Button size="sm" variant="secondary" icon={<RotateCcw />} onClick={() => setStep(0)}>
                Replay
              </Button>
            )}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {mounted ? `Step ${step + 1} of ${STEPS.length}: ${current.title}` : ''}
        </p>
      </div>
    </div>
  );
}
