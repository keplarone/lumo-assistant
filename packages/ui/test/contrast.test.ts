/**
 * WCAG 2.2 contrast checks for every text/background pairing the components use, in both themes.
 * Tokens are read straight from tokens.css, so a token change that breaks contrast fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatHex, parse, wcagContrast, type Color } from 'culori';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8');

function block(selector: string) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const vars: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/--(lu-[\w-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

const themes = {
  dark: block(":root,\n[data-theme='dark']"),
  light: { ...block(":root,\n[data-theme='dark']"), ...block("[data-theme='light']") },
};

/** Composite a possibly translucent color over an opaque one (in sRGB, as browsers do). */
function over(fg: Color, bg: Color): Color {
  const a = fg.alpha ?? 1;
  const f = parse(formatHex(fg))!;
  const b = parse(formatHex(bg))!;
  const toRgb = (c: Color) => parse(formatHex(c)) as { r: number; g: number; b: number };
  const F = toRgb(f), B = toRgb(b);
  return { mode: 'rgb', r: F.r * a + B.r * (1 - a), g: F.g * a + B.g * (1 - a), b: F.b * a + B.b * (1 - a) };
}

function color(vars: Record<string, string>, name: string): Color {
  const v = vars[name];
  if (!v) throw new Error(`token ${name} missing`);
  const c = parse(v);
  if (!c) throw new Error(`cannot parse ${name}: ${v}`);
  return c;
}

// [foreground, background, minimum ratio, optional translucent layer between them]
const pairs: [string, string, number, string?][] = [
  ['lu-text', 'lu-bg', 7],
  ['lu-text', 'lu-surface-1', 7],
  ['lu-text', 'lu-surface-2', 7],
  ['lu-text', 'lu-surface-3', 4.5],
  ['lu-text-secondary', 'lu-bg', 4.5],
  ['lu-text-secondary', 'lu-surface-1', 4.5],
  ['lu-text-secondary', 'lu-surface-2', 4.5],
  ['lu-text-tertiary', 'lu-bg', 4.5],
  ['lu-text-tertiary', 'lu-surface-1', 4.5],
  ['lu-text-tertiary', 'lu-bg-sunken', 4.5],
  ['lu-accent-text', 'lu-bg', 4.5],
  ['lu-accent-text', 'lu-surface-1', 4.5],
  ['lu-accent-text', 'lu-bg', 4.5, 'lu-accent-subtle'],
  ['lu-text-on-accent', 'lu-accent', 4.5],
  ['lu-text-on-accent', 'lu-accent-hover', 4.5],
  ['lu-text-on-accent', 'lu-danger-solid', 4.5],
  ['lu-text-on-accent', 'lu-danger-solid-hover', 4.5],
  ['lu-text-on-accent', 'lu-accent-pressed', 4.5],
  ['lu-danger-text', 'lu-bg', 4.5],
  ['lu-danger-text', 'lu-surface-2', 4.5],
  ['lu-danger-text', 'lu-bg', 4.5, 'lu-danger-subtle'],
  ['lu-success', 'lu-bg', 4.5, 'lu-success-subtle'],
  ['lu-warning', 'lu-bg', 4.5, 'lu-warning-subtle'],
  ['lu-lumen-text', 'lu-bg', 4.5, 'lu-lumen-subtle'],
  // Non-text UI: focus ring and the live (privacy) indicator need 3:1 against their surroundings.
  ['lu-focus', 'lu-bg', 3],
  ['lu-focus', 'lu-surface-2', 3],
  ['lu-live', 'lu-bg', 3],
  ['lu-live', 'lu-surface-1', 3],
];

describe.each(Object.entries(themes))('%s theme contrast', (_name, vars) => {
  it.each(pairs)('%s on %s ≥ %s', (fg, bg, min, layer) => {
    let back = color(vars, bg);
    if (layer) back = over(color(vars, layer), back);
    const ratio = wcagContrast(color(vars, fg), back);
    expect(ratio, `${fg} on ${layer ? layer + ' over ' : ''}${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
  });
});
