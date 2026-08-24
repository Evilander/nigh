import { StringDecoder } from 'node:string_decoder';

// CSI sequences (colours "...m", cursor clears "...K"/"...J"), OSC sequences
// (terminal hyperlinks, window titles: ESC ] ... BEL or ESC ] ... ESC \), and
// two-byte ESC codes. OSC is tried before the two-byte fallback: "]" (like
// "[") falls in the two-byte class, so trying that alternative first would
// match only "ESC ]" and leave the hyperlink body and terminator behind.
const ANSI_RE = /\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:|\\)|[@-_]/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

// Retained-tail cap: a stream with no line terminator for this long stops
// being parsed. Without this, an unbroken stream (binary data, or just a
// very long line) makes tail + decoder.write(chunk) copy an ever-growing
// string on every push() call.
const MAX_TAIL_CHARS = 64 * 1024;

// Cheap binary heuristic: a NUL byte essentially never appears in text a
// program prints, but is common early in arbitrary binary data.
const NUL_CHAR = String.fromCharCode(0);
function looksBinary(chunk) {
  return typeof chunk === 'string' ? chunk.indexOf(NUL_CHAR) !== -1 : chunk.includes(0);
}

export function createLineSplitter() {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  // A \r in last position of a push is emitted as a terminator right away;
  // if the next push starts with \n, that \n completes the CRLF and is swallowed.
  let crAtEnd = false;
  // Once a stream looks binary, stop trying to parse it as lines: nothing
  // useful will come from it, and it's usually just wasted work. The caller
  // still writes the raw chunk through untouched; this only affects parsing.
  let binary = false;

  function splitInto(buf, lines) {
    let start = 0;
    let i = 0;
    while (i < buf.length) {
      const ch = buf[i];
      if (ch !== '\r' && ch !== '\n') {
        i += 1;
        continue;
      }
      lines.push(stripAnsi(buf.slice(start, i)));
      if (ch === '\r' && buf[i + 1] === '\n') i += 2;
      else {
        if (ch === '\r' && i === buf.length - 1) crAtEnd = true;
        i += 1;
      }
      start = i;
    }
    return buf.slice(start);
  }

  return {
    push(chunk) {
      if (binary) return [];
      if (looksBinary(chunk)) {
        binary = true;
        tail = '';
        return [];
      }
      let buf = tail + decoder.write(chunk);
      tail = '';
      if (crAtEnd && buf.length > 0) {
        crAtEnd = false;
        if (buf.startsWith('\n')) buf = buf.slice(1);
      }
      const lines = [];
      tail = splitInto(buf, lines);
      if (tail.length > MAX_TAIL_CHARS) {
        // No terminator in a very long stretch: this is not going to
        // usefully parse as a counter. Drop it so an unbroken stream can't
        // grow this string (and the cost of rebuilding it every push) without bound.
        tail = '';
      }
      return lines;
    },
    flush() {
      if (binary) {
        decoder.end();
        return [];
      }
      const rest = tail + decoder.end();
      tail = '';
      crAtEnd = false;
      return rest ? [stripAnsi(rest)] : [];
    },
  };
}

const NUM = String.raw`\d[\d,_]*`;
const DECIMAL_NUM = String.raw`${NUM}(?:\.\d[\d,_]*)?`;

const FRACTION_RE = new RegExp(`(${NUM})\\s*/\\s*(${NUM})`, 'g');
const OF_RE = new RegExp(`(${NUM})\\s+of\\s+(${NUM})`, 'gi');
const PERCENT_RE = new RegExp(`(${DECIMAL_NUM})\\s*%`, 'g');

// Digits may carry , or _ group separators.
function plainNumber(token) {
  return Number(token.replace(/[,_]/g, ''));
}

const YEAR_TOK = /^(19|20)\d{2}$/;
const SHORT_TOK = /^\d{1,2}$/;

function fractionFrom(line, m) {
  const value = plainNumber(m[1]);
  const total = plainNumber(m[2]);
  if (!(total > 0) || value > total) return null;
  const before = m.index > 0 ? line[m.index - 1] : '';
  if (/[A-Za-z./\\]/.test(before)) return null; // version "v1/2", decimal "1.5/2", or a path segment
  const rest = line.slice(m.index + m[0].length);
  if (rest.startsWith('.')) return null; // decimal "2/2.5" or path "2/3.js"
  if (/^\s*[/\\]/.test(rest)) return null; // three-part date chain "08/24/2026" or a path continuation
  if ((YEAR_TOK.test(m[1]) && SHORT_TOK.test(m[2])) || (YEAR_TOK.test(m[2]) && SHORT_TOK.test(m[1]))) {
    return null; // year/month or month/year "2026/08"
  }
  return { start: m.index, end: m.index + m[0].length, kind: 'fraction', value, total };
}

function ofFrom(m) {
  const value = plainNumber(m[1]);
  const total = plainNumber(m[2]);
  if (!(total > 0) || value > total) return null;
  return { start: m.index, end: m.index + m[0].length, kind: 'of', value, total };
}

function percentFrom(m) {
  const value = plainNumber(m[1]);
  if (!(value >= 0 && value <= 100)) return null;
  return { start: m.index, end: m.index + m[0].length, kind: 'percent', value, total: 100 };
}

// Up to two letter tokens immediately before the counter: punctuation and
// whitespace are skipped backwards, a digit stops the scan.
function labelBefore(line, start) {
  const tokens = [];
  let i = start;
  while (i > 0 && tokens.length < 2) {
    const ch = line[i - 1];
    if (/\d/.test(ch)) break;
    if (/[A-Za-z]/.test(ch)) {
      let j = i - 1;
      while (j > 0 && /[A-Za-z]/.test(line[j - 1])) j -= 1;
      tokens.unshift(line.slice(j, i).toLowerCase());
      i = j;
      continue;
    }
    i -= 1;
  }
  return tokens.join(' ');
}

export function extractCounters(line) {
  const found = [];
  for (const m of line.matchAll(FRACTION_RE)) {
    const c = fractionFrom(line, m);
    if (c) found.push(c);
  }
  for (const m of line.matchAll(OF_RE)) {
    const c = ofFrom(m);
    if (c) found.push(c);
  }
  for (const m of line.matchAll(PERCENT_RE)) {
    const c = percentFrom(m);
    if (c) found.push(c);
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let keptEnd = 0;
  for (const c of found) {
    if (c.start < keptEnd) continue; // overlapping with an earlier counter
    keptEnd = c.end;
    out.push({
      kind: c.kind,
      value: c.value,
      total: c.total,
      label: labelBefore(line, c.start),
      raw: line.slice(c.start, c.end),
    });
  }
  return out;
}
