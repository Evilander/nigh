import { formatDuration, formatEta } from './estimate.js';

const BAR_CELLS = 16;
const CLEAR_LINE = '\r\x1b[2K';
const RESET_COLOR = '\x1b[0m';
const NAMED_COLORS = new Map([
  ['black', 30],
  ['red', 31],
  ['green', 32],
  ['yellow', 33],
  ['blue', 34],
  ['magenta', 35],
  ['cyan', 36],
  ['white', 37],
  ['bright-black', 90],
  ['bright-red', 91],
  ['bright-green', 92],
  ['bright-yellow', 93],
  ['bright-blue', 94],
  ['bright-magenta', 95],
  ['bright-cyan', 96],
  ['bright-white', 97],
]);

export function normalizeColor(value, optionName = 'color') {
  const color = value === undefined || value === null ? 'none' : String(value).trim().toLowerCase();
  if (color === '' || color === 'none') return 'none';
  if (color === 'gray' || color === 'grey') return 'bright-black';
  if (NAMED_COLORS.has(color) || /^#[0-9a-f]{6}$/.test(color)) return color;
  throw new Error(`${optionName} has unsupported color "${value}"`);
}

export function normalizeColorMode(value) {
  const mode = value === undefined || value === null ? 'auto' : String(value).trim().toLowerCase();
  if (mode === 'auto' || mode === 'always' || mode === 'never') return mode;
  throw new Error(`--color must be auto, always, or never; got "${value}"`);
}

function colorCode(color) {
  if (color.startsWith('#')) {
    const red = Number.parseInt(color.slice(1, 3), 16);
    const green = Number.parseInt(color.slice(3, 5), 16);
    const blue = Number.parseInt(color.slice(5, 7), 16);
    return `\x1b[38;2;${red};${green};${blue}m`;
  }
  return `\x1b[${NAMED_COLORS.get(color)}m`;
}

function paint(text, color) {
  if (text.length === 0 || color === 'none') return text;
  return `${colorCode(color)}${text}${RESET_COLOR}`;
}

export function statusText(view) {
  const hasFraction = view.fraction !== null && view.fraction !== undefined;
  const parts = [];
  if (hasFraction) {
    const cells = view.width ?? BAR_CELLS;
    // Clamp before deriving filled/empty cell counts: an out-of-range
    // fraction would otherwise make cells - filled negative, and
    // String.prototype.repeat() throws on a negative count.
    const fraction = Math.min(1, Math.max(0, view.fraction));
    const filled = Math.round(fraction * cells);
    const filledCells = (view.ascii ? '#' : '█').repeat(filled);
    const emptyCells = (view.ascii ? '-' : '░').repeat(cells - filled);
    const bar = view.colorEnabled
      ? paint(filledCells, normalizeColor(view.barColor)) + paint(emptyCells, normalizeColor(view.trackColor))
      : filledCells + emptyCells;
    const barText = view.ascii ? `nigh [${bar}]` : `nigh ▕${bar}▏`;
    parts.push(`${barText} ${Math.round(fraction * 100)}%`);
  } else {
    parts.push('nigh');
  }
  parts.push(formatEta(view.est));
  parts.push(`${formatDuration(view.est.elapsedSeconds)} elapsed`);
  if (hasFraction && view.total != null) {
    const prefix = view.label ? `${view.label} ` : '';
    parts.push(`${prefix}${view.value}/${view.total}`);
  }
  return parts.join(' · ');
}

export function createStatusLine(stream, opts) {
  const tty = opts.isTTY;
  const intervalMs = opts.intervalMs ?? 5000;
  const now = opts.now ?? Date.now;
  let lastText = null; // TTY: last drawn status; non-TTY: last written text
  let lastWriteAt = -Infinity;

  return {
    update(text) {
      if (tty) {
        lastText = text;
        stream.write(CLEAR_LINE + text);
        return;
      }
      if (text === lastText) return;
      const t = now();
      if (t - lastWriteAt < intervalMs) return;
      lastWriteAt = t;
      lastText = text;
      stream.write(`${text}\n`);
    },
    passthrough(chunk) {
      if (!tty) {
        stream.write(chunk);
        return;
      }
      stream.write(CLEAR_LINE);
      stream.write(chunk);
      if (lastText !== null) stream.write(CLEAR_LINE + lastText);
    },
    done(text = '') {
      if (!tty) {
        stream.write(`${text}\n`);
        return;
      }
      stream.write(CLEAR_LINE + text + '\n');
      lastText = null;
    },
    clear() {
      if (!tty) return;
      stream.write(CLEAR_LINE);
      lastText = null;
    },
  };
}
