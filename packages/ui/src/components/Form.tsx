import * as RCheckbox from '@radix-ui/react-checkbox';
import * as RSelect from '@radix-ui/react-select';
import * as RSwitch from '@radix-ui/react-switch';
import { clsx } from 'clsx';
import { Check, ChevronDown, Minus } from 'lucide-react';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx('lu-input', className)} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with content up to maxRows (then scroll). */
  autoSize?: boolean;
  maxRows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoSize, maxRows = 12, value, ...rest },
  forwarded,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!autoSize || !el) return;
    el.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
    el.style.height = `${Math.min(el.scrollHeight, lh * maxRows + pad)}px`;
  }, [autoSize, maxRows, value]);
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof forwarded === 'function') forwarded(el);
        else if (forwarded) forwarded.current = el;
      }}
      className={clsx('lu-textarea', className)}
      value={value}
      data-autosize={autoSize || undefined}
      {...rest}
    />
  );
});

export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  /** A single form control; it receives id and aria attributes. */
  children: ReactElement<Record<string, unknown>>;
  className?: string;
}

/** Label + control + description/error, wired for assistive technology. */
export function Field({ label, description, error, children, className }: FieldProps) {
  const id = useId();
  const descId = description ? `${id}-desc` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-describedby': [descId, errId].filter(Boolean).join(' ') || undefined,
        'aria-invalid': error ? true : undefined,
      })
    : children;
  return (
    <div className={clsx('lu-field', className)}>
      <label className="lu-field-label" htmlFor={id}>
        {label}
      </label>
      {control}
      {description && (
        <div className="lu-field-description" id={descId}>
          {description}
        </div>
      )}
      {error && (
        <div className="lu-field-error" id={errId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

export function Switch(props: SwitchProps) {
  return (
    <RSwitch.Root className="lu-switch" {...props}>
      <RSwitch.Thumb className="lu-switch-thumb" />
    </RSwitch.Root>
  );
}

export interface CheckboxProps {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

export function Checkbox({ onCheckedChange, ...props }: CheckboxProps) {
  return (
    <RCheckbox.Root className="lu-checkbox" onCheckedChange={(c) => onCheckedChange(c === true)} {...props}>
      <RCheckbox.Indicator>{props.checked === 'indeterminate' ? <Minus strokeWidth={3} /> : <Check strokeWidth={3} />}</RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

export function Select({ value, onValueChange, options, placeholder, disabled, className, ...aria }: SelectProps) {
  return (
    <RSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RSelect.Trigger className={clsx('lu-select-trigger', className)} {...aria}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon>
          <ChevronDown />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="lu-select-content" position="popper" sideOffset={4}>
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="lu-select-item">
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator style={{ marginLeft: 'auto' }}>
                  <Check />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/** A small radio group rendered as a segmented control. Arrow keys move the selection. */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: SegmentedOption<T>[];
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (dir: 1 | -1) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + dir + options.length) % options.length]!;
    onValueChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };
  return (
    <div
      className="lu-segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (e.preventDefault(), move(1));
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (e.preventDefault(), move(-1));
      }}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="lu-segmented-item"
          onClick={() => onValueChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
