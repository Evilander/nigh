import { formatDuration, formatEta } from './estimate.js';

const BAR_CELLS = 16;
const CLEAR_LINE = '\r\x1b[2K';

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
    const bar = view.ascii
      ? '#'.repeat(filled) + '-'.repeat(cells - filled)
      : '█'.repeat(filled) + '░'.repeat(cells - filled);
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