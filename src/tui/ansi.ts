/**
 * Minimal ANSI toolkit for the board: no dependency, works over SSH and in any
 * VT100-compatible terminal. Colors are optional (NO_COLOR) and never the only
 * carrier of meaning: every state also has a text label.
 */

const ESC = '\x1b[';

export const screen = {
  enterAlt: `${ESC}?1049h`,
  leaveAlt: `${ESC}?1049l`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  home: `${ESC}H`,
  clearLine: `${ESC}K`,
  clearBelow: `${ESC}J`,
};

export type Style = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan' | 'magenta' | 'inverse';

const CODES: Record<Style, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  inverse: [7, 27],
};

export function colorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

export type Paint = (text: string, ...styles: Style[]) => string;

export function painter(enabled: boolean): Paint {
  if (!enabled) return (text) => text;
  return (text, ...styles) => styles.reduce((t, s) => `${ESC}${CODES[s][0]}m${t}${ESC}${CODES[s][1]}m`, text);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

/** Removes control characters that could move the cursor or fake UI (logs are untrusted text). */
// eslint-disable-next-line no-control-regex
export const sanitize = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '  ');

/** Visible columns (one per code point; the board only uses single-width glyphs). */
export const visibleWidth = (text: string): number => [...stripAnsi(text)].length;

/**
 * Cuts or pads `text` to exactly `width` visible columns, keeping ANSI codes
 * intact. A cut is shown with «…» and styles are reset after it.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const total = visibleWidth(text);
  const limit = total > width ? width - 1 : width;
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < limit) {
    const m = text[i] === '\x1b' ? /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i)) : null;
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    out += cp;
    visible++;
    i += cp.length;
  }
  const reset = out.includes('\x1b') ? `${ESC}0m` : '';
  return total > width ? `${out}…${reset}` : `${out}${reset}${' '.repeat(width - visible)}`;
}

/** Wraps plain text to `width` columns (for detail and text screens). */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = [...raw];
    if (line.length === 0) out.push('');
    while (line.length > 0) {
      out.push(line.slice(0, width).join(''));
      line = line.slice(width);
    }
  }
  return out;
}
