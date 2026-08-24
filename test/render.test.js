import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusText, createStatusLine } from '../src/render.js';

function est(overrides = {}) {
  return {
    fraction: 0.42,
    elapsedSeconds: 80,
    etaSeconds: 190,
    lowSeconds: 160,
    highSeconds: 240,
    rateRecent: null,
    rateOverall: null,
    basis: 'observed',
    ...overrides,
  };
}

function fakeStream() {
  const writes = [];
  return {
    writes,
    write(chunk) {
      writes.push(chunk.toString());
    },
  };
}

test('statusText renders the unicode bar form', () => {
  const text = statusText({
    fraction: 0.42,
    est: est(),
    label: 'files',
    value: 51,
    total: 120,
  });
  assert.equal(
    text,
    'nigh ▕███████░░░░░░░░░▏ 42% · 3m10s left (2m40s-4m00s) · 1m20s elapsed · files 51/120',
  );
});

test('statusText renders the ascii bar form', () => {
  const text = statusText({
    fraction: 0.42,
    est: est(),
    label: 'files',
    value: 51,
    total: 120,
    ascii: true,
  });
  assert.equal(
    text,
    'nigh [#######---------] 42% · 3m10s left (2m40s-4m00s) · 1m20s elapsed · files 51/120',
  );
});

test('statusText with fraction null shows no bar and estimating...', () => {
  const text = statusText({
    fraction: null,
    est: est({ fraction: null, elapsedSeconds: 12, etaSeconds: null, lowSeconds: null, highSeconds: null, basis: 'none' }),
    label: '',
    value: null,
    total: null,
  });
  assert.equal(text, 'nigh · estimating... · 12s elapsed');
});

test('statusText with a prior estimate reports it without a bar', () => {
  const text = statusText({
    fraction: null,
    est: est({ fraction: null, etaSeconds: 290, lowSeconds: null, highSeconds: null, basis: 'prior' }),
    label: '',
    value: null,
    total: null,
  });
  assert.equal(text, 'nigh · about 4m50s (from history) · 1m20s elapsed');
});

test('statusLine in TTY mode rewrites the line in place on update()', () => {
  const stream = fakeStream();
  const line = createStatusLine(stream, { isTTY: true });
  line.update('hello');
  assert.deepEqual(stream.writes, ['\r\x1b[2Khello']);
});

test('statusLine in TTY mode clears, passes the chunk through, then redraws', () => {
  const stream = fakeStream();
  const line = createStatusLine(stream, { isTTY: true });
  line.update('st');
  stream.writes.length = 0;
  line.passthrough(Buffer.from('LOG\n'));
  assert.deepEqual(stream.writes, ['\r\x1b[2K', 'LOG\n', '\r\x1b[2Kst']);
});

test('statusLine in TTY mode does not redraw in passthrough before any update', () => {
  const stream = fakeStream();
  const line = createStatusLine(stream, { isTTY: true });
  line.passthrough(Buffer.from('LOG\n'));
  assert.deepEqual(stream.writes, ['\r\x1b[2K', 'LOG\n']);
});

test('statusLine clear() erases the line and stops redraws', () => {
  const stream = fakeStream();
  const line = createStatusLine(stream, { isTTY: true });
  line.update('st');
  line.clear();
  assert.deepEqual(stream.writes, ['\r\x1b[2Kst', '\r\x1b[2K']);
  stream.writes.length = 0;
  line.passthrough(Buffer.from('x'));
  assert.deepEqual(stream.writes, ['\r\x1b[2K', 'x']);
});

test('statusLine done() writes the final text with a newline in TTY mode', () => {
  const stream = fakeStream();
  const line = createStatusLine(stream, { isTTY: true });
  line.done('done in 4m12s');
  assert.deepEqual(stream.writes, ['\r\x1b[2Kdone in 4m12s\n']);
});

test('statusLine in non-TTY mode throttles updates by intervalMs and skips unchanged text', () => {
  let t = 100000;
  const stream = fakeStream();
  const line = createStatusLine(stream, {
    isTTY: false,
    intervalMs: 5000,
    now: () => t,
  });
  line.update('a'); // first update writes immediately
  line.update('a'); // unchanged text: skipped
  t += 1000;
  line.update('b'); // inside the interval window: skipped
  t += 4000;
  line.update('c'); // window has passed: written
  line.update('c'); // unchanged text: skipped
  t += 4999;
  line.update('d'); // still inside the window: skipped
  t += 1;
  line.update('e'); // window passed again: written
  assert.deepEqual(stream.writes, ['a\n', 'c\n', 'e\n']);
});

test('statusLine in non-TTY mode passes chunks through untouched', () => {
  const stream = fakeStream();
  const line = createStatusLine(stream, { isTTY: false });
  line.passthrough(Buffer.from('LOG\n'));
  assert.deepEqual(stream.writes, ['LOG\n']);
});

test('statusLine done() writes the final text unthrottled in non-TTY mode', () => {
  let t = 0;
  const stream = fakeStream();
  const line = createStatusLine(stream, { isTTY: false, intervalMs: 5000, now: () => t });
  line.update('a');
  t += 1; // far inside the throttle window...
  line.update('b'); // ...so this is skipped...
  line.done('final'); // ...but the final line always comes through
  assert.deepEqual(stream.writes, ['a\n', 'final\n']);
});