import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, createLineSplitter, extractCounters } from '../src/parse.js';

test('stripAnsi removes colour, cursor and two-byte escape sequences', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(stripAnsi('\x1b[2K\x1b[1Gcleared'), 'cleared');
  assert.equal(stripAnsi('\x1bMreversed'), 'reversed');
  assert.equal(stripAnsi('no escapes'), 'no escapes');
});

test('splitter: LF, CRLF and lone CR each end a line', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\nb\r\nc\rd'), ['a', 'b', 'c']);
  assert.deepEqual(s.flush(), ['d']);
});

test('splitter: empty lines are preserved', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('\n\nx'), ['', '']);
  assert.deepEqual(s.flush(), ['x']);
});

test('splitter: reassembles a line written across three pushes', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('12'), []);
  assert.deepEqual(s.push('3/4'), []);
  assert.deepEqual(s.push('56\n'), ['123/456']);
  assert.deepEqual(s.flush(), []);
});

test('splitter: multi-byte UTF-8 split across chunks decodes correctly', () => {
  const threeByte = Buffer.from('★ 3/5\n', 'utf8');
  const s1 = createLineSplitter();
  assert.deepEqual(s1.push(threeByte.subarray(0, 2)), []); // ★ cut after its first two bytes
  assert.deepEqual(s1.push(threeByte.subarray(2)), ['★ 3/5']);

  const fourByte = Buffer.from('a😀\n', 'utf8');
  const s2 = createLineSplitter();
  assert.deepEqual(s2.push(fourByte.subarray(0, 3)), []); // 😀 cut after its first two bytes
  assert.deepEqual(s2.push(fourByte.subarray(3)), ['a😀']);
});

test('splitter: trailing CR ends the line immediately and pairs with a leading LF later', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('10%\r'), ['10%']);
  assert.deepEqual(s.push('20%\r\n'), ['20%']); // the LF completes CRLF, no empty line
  assert.deepEqual(s.flush(), []);
});

test('splitter: flush() returns the unterminated tail', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('head\nstill working'), ['head']);
  assert.deepEqual(s.flush(), ['still working']);
  assert.deepEqual(s.flush(), []);
});

test('splitter: ANSI colour and cursor sequences are stripped from lines', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('\x1b[32mok\x1b[0m \x1b[2K3/9\x1b[1A\r'), ['ok 3/9']);
});

test('end-to-end: ANSI progress frames rewritten with CR split and count cleanly', () => {
  const s = createLineSplitter();
  const lines = [
    ...s.push('\x1b[2K\x1b[1Gfiles [41/100]\x1b[0m\r'),
    ...s.push('\x1b[2K\x1b[1Gfiles [42/100]\x1b[0m\r'),
    ...s.flush(),
  ];
  assert.deepEqual(lines, ['files [41/100]', 'files [42/100]']);
  assert.deepEqual(extractCounters(lines[1]), [
    { kind: 'fraction', value: 42, total: 100, label: 'files', raw: '42/100' },
  ]);
});

test('fraction counters', () => {
  assert.deepEqual(extractCounters('[12/120]'), [
    { kind: 'fraction', value: 12, total: 120, label: '', raw: '12/120' },
  ]);
  assert.deepEqual(extractCounters('12 / 120'), [
    { kind: 'fraction', value: 12, total: 120, label: '', raw: '12 / 120' },
  ]);
  assert.deepEqual(extractCounters('1,200/12,000'), [
    { kind: 'fraction', value: 1200, total: 12000, label: '', raw: '1,200/12,000' },
  ]);
  assert.equal(extractCounters('1_200/12_000')[0].value, 1200);
});

test('labels attach to fraction counters', () => {
  assert.equal(extractCounters('files: 3/7')[0].label, 'files');
  assert.equal(extractCounters('Epoch 3/10')[0].label, 'epoch');
});

// Documented choice: the plan says "up to two word tokens immediately before the
// counter", so "Processing item 4 of 20" gets the two-word label "processing item".
test('"of" counters are case-insensitive and take up-to-two-word labels', () => {
  assert.deepEqual(extractCounters('Processing item 4 of 20'), [
    { kind: 'of', value: 4, total: 20, label: 'processing item', raw: '4 of 20' },
  ]);
  assert.deepEqual(extractCounters('4 OF 20'), [
    { kind: 'of', value: 4, total: 20, label: '', raw: '4 OF 20' },
  ]);
});

test('percent counters allow decimals and a space before the sign, total is 100', () => {
  assert.deepEqual(extractCounters('45%'), [
    { kind: 'percent', value: 45, total: 100, label: '', raw: '45%' },
  ]);
  assert.deepEqual(extractCounters('45.5 %'), [
    { kind: 'percent', value: 45.5, total: 100, label: '', raw: '45.5 %' },
  ]);
  assert.deepEqual(extractCounters('100%'), [
    { kind: 'percent', value: 100, total: 100, label: '', raw: '100%' },
  ]);
});

test('several counters in one line come back in line order', () => {
  const counters = extractCounters('1/4 then 50% then 2 of 5');
  assert.deepEqual(counters.map((c) => c.kind), ['fraction', 'percent', 'of']);
  assert.deepEqual(
    counters.map((c) => [c.value, c.total]),
    [[1, 4], [50, 100], [2, 5]],
  );
});

test('overlapping matches keep the earliest counter', () => {
  assert.deepEqual(extractCounters('1/2%'), [
    { kind: 'fraction', value: 1, total: 2, label: '', raw: '1/2' },
  ]);
});

test('decoys yield nothing', () => {
  const decoys = [
    '2026/08/24 12:30:45',
    '08/24/2026',
    'src/app/3.js',
    'v1/2',
    '1.5/2.5',
    'pid 1234 wrote 12345 bytes',
    '150%',
    '12/0',
    '13/12',
  ];
  for (const decoy of decoys) {
    assert.deepEqual(extractCounters(decoy), [], decoy);
  }
});
