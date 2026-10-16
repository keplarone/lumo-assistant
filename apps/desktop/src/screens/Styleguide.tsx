/** Development aid: every @lumo/ui component and the mascot moods, rendered with the live tokens. */
import { MascotMachine, MOOD_NAMES, type MascotOutput } from '@lumo/mascot';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  SegmentedControl,
  Select,
  Separator,
  Skeleton,
  Spinner,
  StatusDot,
  Switch,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  Tooltip,
  useToast,
} from '@lumo/ui';
import { Inbox, MoreHorizontal, Plus, Settings2 } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { routeHref } from '../lib/router';

const LumoMascot = lazy(() => import('@lumo/mascot/react').then((m) => ({ default: m.LumoMascot })));

/** One canvas (browsers cap WebGL contexts), switched between every registered mood. */
function MoodViewer() {
  const moods = MOOD_NAMES;
  const [mood, setMood] = useState(moods[0] ?? 'idle');
  const behavior = useMemo<MascotOutput>(() => ({ ...new MascotMachine().output, mood }), [mood]);
  return (
    <div className="lm-sg-moods">
      <Suspense fallback={<Skeleton width={280} height={240} />}>
        <LumoMascot
          behavior={behavior}
          className="lm-sg-mascot"
          particles={60}
          followPointer={false}
          label="Lumo"
        />
      </Suspense>
      <div className="lm-sg-row" role="group" aria-label="Mood">
        {moods.map((m) => (
          <Button
            key={m}
            size="sm"
            variant={m === mood ? 'primary' : 'secondary'}
            aria-pressed={m === mood}
            onClick={() => setMood(m)}
          >
            {m}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function Styleguide() {
  const toast = useToast();
  const [sw, setSw] = useState(true);
  const [cb, setCb] = useState(true);
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a');
  const [sel, setSel] = useState('one');
  const [dialog, setDialog] = useState(false);
  return (
    <div className="lm-page lm-styleguide">
      <header className="lm-page-header">
        <div>
          <h1 className="lm-page-title">Style guide</h1>
          <p className="lm-page-sub">
            Every @lumo/ui component and the mascot moods. Development builds only.
          </p>
        </div>
        <a className="lm-link" href={routeHref({ name: 'settings', section: 'about' })}>
          Back to settings
        </a>
      </header>
      <section className="lm-section">
        <h2 className="lm-section-title">Buttons</h2>
        <div className="lm-sg-row">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button size="sm" icon={<Plus />}>
            Small
          </Button>
          <Button size="lg">Large</Button>
          <IconButton label="Settings" icon={<Settings2 />} shortcut={['⌘', ',']} />
        </div>
      </section>
      <section className="lm-section">
        <h2 className="lm-section-title">Form</h2>
        <div className="lm-sg-grid">
          <Field label="Input" description="A description">
            <Input placeholder="Placeholder" />
          </Field>
          <Field label="Invalid" error="This needs a value">
            <Input />
          </Field>
          <Field label="Textarea">
            <Textarea autoSize rows={2} />
          </Field>
          <div className="lm-sg-row">
            <Switch checked={sw} onCheckedChange={setSw} aria-label="Switch" />
            <Checkbox checked={cb} onCheckedChange={setCb} aria-label="Checkbox" />
            <Checkbox checked="indeterminate" onCheckedChange={() => {}} aria-label="Indeterminate" />
            <SegmentedControl
              label="Segmented"
              value={seg}
              onValueChange={setSeg}
              options={[
                { value: 'a', label: 'One' },
                { value: 'b', label: 'Two' },
                { value: 'c', label: 'Three' },
              ]}
            />
            <Select
              aria-label="Select"
              value={sel}
              onValueChange={setSel}
              options={[
                { value: 'one', label: 'One' },
                { value: 'two', label: 'Two' },
              ]}
            />
          </div>
        </div>
      </section>
      <section className="lm-section">
        <h2 className="lm-section-title">Display</h2>
        <div className="lm-sg-row">
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="success">Success</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="danger">Danger</Badge>
          <Badge tone="lumen">Lumen</Badge>
          {(['neutral', 'accent', 'success', 'warning', 'danger', 'lumen', 'live'] as const).map((t) => (
            <StatusDot key={t} tone={t} label={t} />
          ))}
          <StatusDot tone="live" pulse label="live, pulsing" />
          <Kbd keys={['⌘', 'K']} />
          <Spinner label="Loading" />
        </div>
        <div className="lm-sg-grid">
          <Callout title="Neutral">A quiet note.</Callout>
          <Callout tone="accent" title="Accent">
            Information.
          </Callout>
          <Callout tone="success" title="Success">
            It worked.
          </Callout>
          <Callout tone="warning" title="Warning">
            Check this.
          </Callout>
          <Callout tone="danger" title="Danger">
            It failed.
          </Callout>
          <Card className="lm-sg-card">A card</Card>
          <Card interactive className="lm-sg-card">
            An interactive card
          </Card>
          <div>
            <ProgressBar value={0.4} label="Determinate" />
            <Separator />
            <ProgressBar label="Indeterminate" />
            <Separator />
            <Skeleton width="60%" />
          </div>
        </div>
        <EmptyState
          icon={<Inbox />}
          title="Empty state"
          description="With a description and an action."
          actions={<Button>Action</Button>}
        />
      </section>
      <section className="lm-section">
        <h2 className="lm-section-title">Overlays</h2>
        <div className="lm-sg-row">
          <Button onClick={() => setDialog(true)}>Dialog</Button>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="Menu" icon={<MoreHorizontal />} />
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>Label</MenuLabel>
              <MenuItem shortcut={['⌘', 'R']}>Item</MenuItem>
              <MenuSeparator />
              <MenuItem tone="danger">Danger</MenuItem>
            </MenuContent>
          </Menu>
          <Popover>
            <PopoverTrigger asChild>
              <Button>Popover</Button>
            </PopoverTrigger>
            <PopoverContent>Popover content</PopoverContent>
          </Popover>
          <Tooltip content="Tooltip">
            <Button>Tooltip</Button>
          </Tooltip>
          <Button
            onClick={() => toast({ title: 'Toast', description: 'With a description', tone: 'success' })}
          >
            Toast
          </Button>
        </div>
        <Tabs defaultValue="a">
          <TabList
            label="Tabs"
            tabs={[
              { value: 'a', label: 'First' },
              { value: 'b', label: 'Second' },
            ]}
          />
          <TabPanel value="a" className="lm-sg-tab">
            First panel
          </TabPanel>
          <TabPanel value="b" className="lm-sg-tab">
            Second panel
          </TabPanel>
        </Tabs>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Dialog"
          description="A description."
          footer={<Button onClick={() => setDialog(false)}>Close</Button>}
        >
          Body
        </Dialog>
      </section>
      <section className="lm-section">
        <h2 className="lm-section-title">Mascot moods</h2>
        <MoodViewer />
      </section>
    </div>
  );
}
