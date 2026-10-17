/**
 * "My day": the morning brief, reminders, bills and subscriptions, and price watches. Everything
 * here is also reachable by asking Lumo in plain words; this page is for seeing it all at once.
 */
import { Button, Dialog, EmptyState, Field, IconButton, Input, Select, Spinner } from '@lumo/ui';
import { Bell, FileSearch, Pencil, Plus, RefreshCw, Sun, Tag, Trash2, Volume2, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { dateTime, relativeTime } from '../lib/format';
import {
  api,
  errorMessage,
  on,
  type Cycle,
  type EverydayOverview,
  type PriceWatch,
  type Recurring,
  type Repeat,
  type Subscription,
  type SubscriptionInput,
} from '../lib/ipc';
import { routeHref } from '../lib/router';
import { speech } from '../lib/speech';
import { useApp } from '../state/app';

const REPEATS: { value: Repeat; label: string }[] = [
  { value: 'none', label: 'Once' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
];
const CYCLES: { value: Cycle; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'weekly', label: 'Weekly' },
];
const PER_MONTH: Record<Cycle, number> = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };

export function money(amount: number, currency: string | null | undefined): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(
      amount,
    );
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayWords(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  const days = Math.round((date.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function Everyday() {
  const app = useApp();
  const [data, setData] = useState<EverydayOverview | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await api.everydayOverview());
    } catch (e) {
      app.reportError(e, 'Couldn’t load your day');
    }
  }, [app]);

  useEffect(() => {
    void reload();
    const subs = [on('everyday-changed', () => void reload()), on('everyday-alert', () => void reload())];
    return () => subs.forEach((s) => void s.then((u) => u()));
  }, [reload]);

  return (
    <div className="lm-page">
      <header className="lm-page-header">
        <div>
          <h1 className="lm-page-title">My day</h1>
          <p className="lm-page-sub">
            Your morning brief, reminders, bills and price watches. You can also just ask Lumo, like “remind
            me to take my meds at 9” or “tell me if these headphones get cheaper”.
          </p>
        </div>
      </header>
      {data === null ? (
        <Spinner label="Loading your day" />
      ) : (
        <>
          <BriefSection data={data} onChange={reload} />
          <RemindersSection data={data} />
          <BillsSection data={data} />
          <PricesSection data={data} />
        </>
      )}
    </div>
  );
}

function BriefSection({ data, onChange }: { data: EverydayOverview; onChange: () => Promise<void> }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const brief = data.brief;
  const make = async () => {
    setBusy(true);
    try {
      const b = await api.makeBriefNow();
      speech.speak(b.text);
      await onChange();
    } catch (e) {
      app.reportError(e, 'Couldn’t make the brief');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lm-section" aria-labelledby="brief-title">
      <h2 className="lm-section-title" id="brief-title">
        Today
      </h2>
      <div className="lm-card lm-brief">
        {brief ? (
          brief.text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)
        ) : (
          <p className="lm-muted">
            {app.settings.briefEnabled
              ? `Your morning brief arrives at ${app.settings.briefTime}. Want it now?`
              : 'The morning brief is off. You can still make one now, or turn it on in Settings.'}
          </p>
        )}
        {brief && brief.data.missing.length > 0 && (
          <p className="lm-muted">Not included yet: {brief.data.missing.join('; ')}.</p>
        )}
        <div className="lm-row-actions">
          <Button size="sm" variant="secondary" icon={<Sun />} loading={busy} onClick={() => void make()}>
            {brief ? 'Brief me again' : 'Brief me now'}
          </Button>
          {brief && (
            <Button size="sm" variant="ghost" icon={<Volume2 />} onClick={() => speech.speak(brief.text)}>
              Read aloud
            </Button>
          )}
          <a className="lm-link" href={routeHref({ name: 'settings', section: 'everyday' })}>
            Brief settings
          </a>
        </div>
      </div>
    </section>
  );
}

function RemindersSection({ data }: { data: EverydayOverview }) {
  const app = useApp();
  const [text, setText] = useState('');
  const [time, setTime] = useState('09:00');
  const [date, setDate] = useState('');
  const [repeat, setRepeat] = useState<Repeat>('none');
  const [error, setError] = useState<string | null>(null);
  const active = data.reminders.filter((r) => !r.done);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return setError('Write what to remind you about.');
    try {
      const r = await api.addReminder({ text: text.trim(), time, date: date || null, repeat });
      setText('');
      setDate('');
      setError(null);
      app.announce(`Reminder set for ${dateTime(r.dueAt)}.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const remove = (id: string) =>
    api.deleteReminder(id).catch((e) => app.reportError(e, 'Couldn’t delete the reminder'));

  return (
    <section className="lm-section" aria-labelledby="reminders-title">
      <h2 className="lm-section-title" id="reminders-title">
        Reminders
      </h2>
      <form className="lm-inline-form lm-everyday-form" onSubmit={(e) => void add(e)}>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Take my meds"
          aria-label="Remind me to"
          maxLength={300}
        />
        <Input
          type="time"
          className="lm-time-input"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label="Time"
          required
        />
        <Input
          type="date"
          className="lm-date-input"
          value={date}
          min={localDate()}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Date (optional)"
        />
        <Select
          value={repeat}
          onValueChange={(v) => setRepeat(v as Repeat)}
          options={REPEATS}
          aria-label="Repeat"
        />
        <Button type="submit" variant="primary" icon={<Plus />}>
          Add
        </Button>
      </form>
      {error && (
        <p className="lm-inline-error" role="alert">
          {error}
        </p>
      )}
      {active.length === 0 ? (
        <p className="lm-muted">No reminders yet.</p>
      ) : (
        <ul className="lm-rows">
          {active.map((r) => (
            <li key={r.id} className="lm-row">
              <Bell className="lm-row-icon" aria-hidden />
              <div className="lm-row-main">
                <span className="lm-row-title">{r.text}</span>
                <span className="lm-row-meta">
                  {dateTime(r.dueAt)}
                  {r.repeat !== 'none' &&
                    ` · ${REPEATS.find((x) => x.value === r.repeat)?.label.toLowerCase()}`}
                </span>
              </div>
              <IconButton
                size="sm"
                label={`Delete “${r.text}”`}
                icon={<Trash2 />}
                onClick={() => void remove(r.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const emptyBill = (): SubscriptionInput => ({
  name: '',
  amount: 0,
  currency: 'USD',
  cycle: 'monthly',
  nextRenewal: localDate(),
  manageUrl: null,
});

function BillsSection({ data }: { data: EverydayOverview }) {
  const app = useApp();
  const [editing, setEditing] = useState<{ id: string | null; input: SubscriptionInput } | null>(null);
  const [found, setFound] = useState<Recurring[] | null>(null);
  const [searching, setSearching] = useState(false);
  const subs = data.subscriptions;

  const totals = new Map<string, number>();
  for (const s of subs) totals.set(s.currency, (totals.get(s.currency) ?? 0) + s.amount * PER_MONTH[s.cycle]);
  const total = [...totals].map(([c, n]) => money(n, c)).join(' + ');

  const edit = (s: Subscription) =>
    setEditing({
      id: s.id,
      input: {
        name: s.name,
        amount: s.amount,
        currency: s.currency,
        cycle: s.cycle,
        nextRenewal: s.nextRenewal,
        manageUrl: s.manageUrl,
      },
    });
  const remove = (s: Subscription) =>
    api.deleteSubscription(s.id).catch((e) => app.reportError(e, 'Couldn’t delete the bill'));
  const scan = async () => {
    setSearching(true);
    try {
      const r = await api.findSubscriptionsInStatement();
      if (r) setFound(r);
    } catch (e) {
      app.reportError(e, 'Couldn’t read that statement');
    } finally {
      setSearching(false);
    }
  };
  const track = async (r: Recurring) => {
    const currency = subs[0]?.currency ?? 'USD';
    try {
      await api.saveSubscription(null, {
        name: r.name,
        amount: r.amount,
        currency,
        cycle: r.cycle,
        nextRenewal: r.nextExpected,
      });
      setFound((f) => f?.filter((x) => x !== r) ?? null);
      app.announce(`Tracking ${r.name}.`);
    } catch (e) {
      app.reportError(e, 'Couldn’t track that bill');
    }
  };

  return (
    <section className="lm-section" aria-labelledby="bills-title">
      <div className="lm-section-head">
        <h2 className="lm-section-title" id="bills-title">
          Bills and subscriptions{subs.length > 0 && ` · about ${total} a month`}
        </h2>
        <div className="lm-row-actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<FileSearch />}
            loading={searching}
            onClick={() => void scan()}
          >
            Find in a statement
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus />}
            onClick={() => setEditing({ id: null, input: emptyBill() })}
          >
            Add a bill
          </Button>
        </div>
      </div>
      {subs.length === 0 ? (
        <EmptyState
          icon={<Wallet />}
          title="No bills tracked yet"
          description="Lumo warns you 3 days before each one renews. Add them yourself, or pick a bank statement (a CSV file) and Lumo finds the repeating charges. The file is read on this computer and never uploaded."
        />
      ) : (
        <ul className="lm-rows">
          {subs.map((s) => (
            <li key={s.id} className="lm-row">
              <Wallet className="lm-row-icon" aria-hidden />
              <div className="lm-row-main">
                <span className="lm-row-title">{s.name}</span>
                <span className="lm-row-meta">
                  {money(s.amount, s.currency)} {s.cycle} · renews {dayWords(s.nextRenewal)}
                </span>
              </div>
              {s.manageUrl && (
                <a className="lm-link" href={s.manageUrl} target="_blank" rel="noreferrer noopener">
                  Manage
                </a>
              )}
              <IconButton size="sm" label={`Edit ${s.name}`} icon={<Pencil />} onClick={() => edit(s)} />
              <IconButton
                size="sm"
                label={`Delete ${s.name}`}
                icon={<Trash2 />}
                onClick={() => void remove(s)}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && <BillDialog initial={editing} onClose={() => setEditing(null)} />}
      <Dialog
        open={found !== null}
        onOpenChange={(o) => !o && setFound(null)}
        title="Repeating charges"
        description="Charges that came back at a regular interval in that statement. Track the ones you want warnings for."
        footer={<Button onClick={() => setFound(null)}>Done</Button>}
      >
        {found && found.length === 0 ? (
          <p className="lm-muted">
            No repeating charges found. Statements covering two or more months work best.
          </p>
        ) : (
          <ul className="lm-rows">
            {found?.map((r) => (
              <li key={`${r.name}-${r.amount}`} className="lm-row">
                <div className="lm-row-main">
                  <span className="lm-row-title">{r.name}</span>
                  <span className="lm-row-meta">
                    {r.amount.toFixed(2)} {r.cycle} · seen {r.timesSeen} times · next around{' '}
                    {dayWords(r.nextExpected)}
                  </span>
                </div>
                <Button size="sm" variant="secondary" onClick={() => void track(r)}>
                  Track
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </section>
  );
}

function BillDialog({
  initial,
  onClose,
}: {
  initial: { id: string | null; input: SubscriptionInput };
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial.input);
  const [amount, setAmount] = useState(initial.id ? String(initial.input.amount) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SubscriptionInput>) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = Number(amount.replace(',', '.'));
    if (!form.name.trim()) return setError('Give it a name.');
    if (!Number.isFinite(n) || n <= 0) return setError('Enter the amount, like 15.49.');
    setBusy(true);
    try {
      await api.saveSubscription(initial.id, {
        ...form,
        name: form.name.trim(),
        amount: n,
        currency: form.currency.trim().toUpperCase(),
        manageUrl: form.manageUrl?.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial.id ? 'Edit bill' : 'Add a bill'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form className="lm-form" onSubmit={(e) => void save(e)}>
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Netflix"
            maxLength={80}
          />
        </Field>
        <div className="lm-inline-form">
          <Field label="Amount">
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="15.49"
            />
          </Field>
          <Field label="Currency">
            <Input
              value={form.currency}
              onChange={(e) => set({ currency: e.target.value })}
              maxLength={3}
              className="lm-time-input"
            />
          </Field>
          <Field label="Every">
            <Select value={form.cycle} onValueChange={(v) => set({ cycle: v as Cycle })} options={CYCLES} />
          </Field>
        </div>
        <Field label="Next renewal">
          <Input
            type="date"
            value={form.nextRenewal}
            onChange={(e) => set({ nextRenewal: e.target.value })}
          />
        </Field>
        <Field
          label="Where to manage it (optional)"
          description="A link to the page where you can cancel or change it."
        >
          <Input
            type="url"
            value={form.manageUrl ?? ''}
            onChange={(e) => set({ manageUrl: e.target.value })}
            placeholder="https://"
          />
        </Field>
        {error && (
          <p className="lm-inline-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function PricesSection({ data }: { data: EverydayOverview }) {
  const app = useApp();
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [targetFor, setTargetFor] = useState<PriceWatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const t = target.trim() ? Number(target.replace(',', '.')) : null;
    if (t !== null && (!Number.isFinite(t) || t <= 0))
      return setError('The target price should be a number.');
    setBusy(true);
    try {
      const w = await api.watchPrice(url.trim(), null, t);
      setUrl('');
      setTarget('');
      setError(null);
      app.announce(
        w.lastPrice !== null
          ? `Watching ${w.name}, now ${money(w.lastPrice, w.currency)}.`
          : `Watching ${w.name}.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const checkNow = async (w: PriceWatch) => {
    setChecking(w.id);
    try {
      await api.checkPriceNow(w.id);
    } catch (e) {
      app.reportError(e, 'Couldn’t check the price');
    } finally {
      setChecking(null);
    }
  };
  const remove = (w: PriceWatch) =>
    api.deletePriceWatch(w.id).catch((e) => app.reportError(e, 'Couldn’t stop watching'));

  return (
    <section className="lm-section" aria-labelledby="prices-title">
      <h2 className="lm-section-title" id="prices-title">
        Price watch
      </h2>
      <form className="lm-inline-form lm-everyday-form" onSubmit={(e) => void add(e)}>
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a product link"
          aria-label="Product link"
          required
        />
        <Input
          inputMode="decimal"
          className="lm-time-input"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Target (optional)"
          aria-label="Target price (optional)"
        />
        <Button type="submit" variant="primary" icon={<Plus />} loading={busy}>
          Watch
        </Button>
      </form>
      {error && (
        <p className="lm-inline-error" role="alert">
          {error}
        </p>
      )}
      <p className="lm-muted">
        Lumo checks each product a few times a day and tells you when it gets cheaper. Some shops block
        automatic checks; Lumo says so when that happens.
      </p>
      {data.priceWatches.length > 0 && (
        <ul className="lm-rows">
          {data.priceWatches.map((w) => (
            <li key={w.id} className="lm-row">
              <Tag className="lm-row-icon" aria-hidden />
              <div className="lm-row-main">
                <a className="lm-row-title lm-link" href={w.url} target="_blank" rel="noreferrer noopener">
                  {w.name}
                </a>
                <span className="lm-row-meta">
                  {w.lastPrice !== null ? `Now ${money(w.lastPrice, w.currency)}` : 'No price yet'}
                  {w.firstPrice !== null &&
                    w.firstPrice !== w.lastPrice &&
                    ` · was ${money(w.firstPrice, w.currency)}`}
                  {w.lowestPrice !== null &&
                    w.lowestPrice !== w.lastPrice &&
                    ` · lowest ${money(w.lowestPrice, w.currency)}`}
                  {w.targetPrice !== null && ` · target ${money(w.targetPrice, w.currency)}`}
                  {w.lastCheckedAt && ` · checked ${relativeTime(w.lastCheckedAt)}`}
                </span>
                {w.lastError && <span className="lm-row-meta lm-inline-error">{w.lastError}</span>}
              </div>
              <IconButton
                size="sm"
                label={`Check ${w.name} now`}
                icon={<RefreshCw />}
                loading={checking === w.id}
                onClick={() => void checkNow(w)}
              />
              <IconButton
                size="sm"
                label={`Set a target for ${w.name}`}
                icon={<Pencil />}
                onClick={() => setTargetFor(w)}
              />
              <IconButton
                size="sm"
                label={`Stop watching ${w.name}`}
                icon={<Trash2 />}
                onClick={() => void remove(w)}
              />
            </li>
          ))}
        </ul>
      )}
      {targetFor && <TargetDialog watch={targetFor} onClose={() => setTargetFor(null)} />}
    </section>
  );
}

function TargetDialog({ watch, onClose }: { watch: PriceWatch; onClose: () => void }) {
  const [value, setValue] = useState(watch.targetPrice !== null ? String(watch.targetPrice) : '');
  const [error, setError] = useState<string | null>(null);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = value.trim() ? Number(value.replace(',', '.')) : null;
    if (t !== null && (!Number.isFinite(t) || t <= 0)) return setError('Enter a price, or leave it empty.');
    try {
      await api.setPriceTarget(watch.id, t);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Target price"
      description={`Lumo tells you about every drop, and makes a bigger fuss when ${watch.name} reaches this price.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void save(e)}>
        <Field label="Target price" description="Leave empty for no target." error={error}>
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}
