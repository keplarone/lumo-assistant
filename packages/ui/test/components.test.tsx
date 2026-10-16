// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, Field, IconButton, Input, ProgressBar, SegmentedControl, TooltipProvider } from '../src';

afterEach(cleanup);

describe('Button', () => {
  it('blocks clicks and announces busy while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b).toHaveProperty('disabled', true);
    expect(b.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('defaults to type=button so it never submits a form by accident', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });
});

describe('IconButton', () => {
  it('is named by its label', () => {
    render(
      <TooltipProvider>
        <IconButton label="Attach file" icon={<svg />} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeTruthy();
  });
});

describe('Field', () => {
  it('wires label, description and error to the control', () => {
    render(
      <Field label="API key" description="Stored in your keychain" error="Key is required">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('API key');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby')!.split(' ');
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Stored in your keychain',
      'Key is required',
    ]);
  });
});

describe('ProgressBar', () => {
  it('reports determinate values and omits them when indeterminate', () => {
    const { rerender } = render(<ProgressBar label="Upload" value={0.42} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    rerender(<ProgressBar label="Upload" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });
});

describe('SegmentedControl', () => {
  function Harness() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a');
    return (
      <SegmentedControl
        label="View"
        value={v}
        onValueChange={setV}
        options={[
          { value: 'a', label: 'Chat' },
          { value: 'b', label: 'Split' },
          { value: 'c', label: 'Preview' },
        ]}
      />
    );
  }
  it('moves selection with arrow keys and wraps', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'View' });
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Preview' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe('true');
  });
});
