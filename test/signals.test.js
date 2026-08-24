import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/signals.js';

// Hand-built Counter matching the shape src/parse.js produces.
const frac = (value, total, label = '') => ({ kind: 'fraction', value, total, label, raw: '' });
const ofc = (value, total, label = '') => ({ kind: 'of', value, total, label, raw: '' });
const pct = (value, label = '') => ({ kind: 'percent', value, total: 100, label, raw: '' });

test('signals are keyed by kind, label and total', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 10, 'epoch'), frac(1, 10, ''), pct(5, 'epoch')], 0);
  assert.deepEqual(tracker.all().map((s) => s.key).sort(), [
    'fraction::10',
    'fraction:epoch:10',
    'percent:epoch:100',
  ]);
});

test('observe appends samples and keeps first/last fresh', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 10)], 100);
  tracker.observe([frac(2, 10)], 250);
  tracker.observe([frac(3, 10)], 500);
  const [s] = tracker.all();
  assert.equal(s.samples.length, 3);
  assert.deepEqual(s.first, { t: 100, value: 1 });
  assert.deepEqual(s.last, { t: 500, value: 3 });
  assert.equal(s.fraction(), 0.3);
  assert.equal(s.resets, 0);
});

test('a lower value is a reset: the cycle restarts with the new sample', () => {
  const tracker = createTracker();
  for (let i = 1; i <= 5; i++) tracker.observe([frac(i, 10)], i * 100);
  tracker.observe([frac(4, 10)], 600);
  tracker.observe([frac(5, 10)], 700);
  const [s] = tracker.all();
  assert.equal(s.resets, 1);
  assert.equal(s.samples.length, 2);
  assert.deepEqual(s.first, { t: 600, value: 4 });
  assert.equal(s.last.value, 5);
  assert.equal(s.fraction(), 0.5);
});

test('an equal value is not a reset', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 10)], 0);
  tracker.observe([frac(1, 10)], 100);
  const [s] = tracker.all();
  assert.equal(s.resets, 0);
  assert.equal(s.samples.length, 2);
});

test('percent fraction is value/100', () => {
  const tracker = createTracker();
  tracker.observe([pct(45)], 0);
  assert.equal(tracker.all()[0].fraction(), 0.45);
});

test('primary prefers fewer resets even when the other kind ranks better', () => {
  const tracker = createTracker();
  for (let i = 1; i <= 3; i++) tracker.observe([frac(i, 10, 'loop'), pct(10 * i, 'item')], i * 100);
  tracker.observe([frac(2, 10, 'loop')], 400); // only the fraction resets
  assert.equal(tracker.primary().key, 'percent:item:100');
});

test('primary prefers fraction over percent at equal resets', () => {
  const tracker = createTracker();
  tracker.observe([pct(50, 'p'), frac(1, 10, 'f')], 0);
  assert.equal(tracker.primary().kind, 'fraction');
});

test('primary prefers of over percent at equal resets', () => {
  const tracker = createTracker();
  tracker.observe([pct(50, 'p'), ofc(1, 10, 'o')], 0);
  assert.equal(tracker.primary().kind, 'of');
});

test('primary prefers the larger total within a kind', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 50, 'small'), frac(1, 100, 'large')], 0);
  tracker.observe([frac(2, 50, 'small'), frac(2, 100, 'large')], 100);
  assert.equal(tracker.primary().key, 'fraction:large:100');
});

test('primary prefers more samples when totals tie', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 10, 'a'), frac(1, 10, 'b')], 0);
  tracker.observe([frac(2, 10, 'a')], 1000);
  tracker.observe([frac(2, 10, 'a'), frac(2, 10, 'b')], 2000);
  assert.equal(tracker.primary().key, 'fraction:a:10');
});

test('primary prefers the most recently updated signal', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 10, 'a')], 0);
  tracker.observe([frac(1, 10, 'b')], 100);
  assert.equal(tracker.primary().key, 'fraction:b:10');
});

test('a full tie goes to the earliest seen signal', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 10, 'a')], 0);
  tracker.observe([frac(1, 10, 'b')], 100);
  tracker.observe([frac(2, 10, 'a'), frac(2, 10, 'b')], 200);
  assert.equal(tracker.primary().key, 'fraction:a:10');
});

test('an empty tracker has no primary and no signals', () => {
  assert.equal(createTracker().primary(), null);
  assert.deepEqual(createTracker().all(), []);
});

test('primary is sticky: an established outer fraction is not displaced by a same-kind ' +
  'inner fraction with a larger total, before the inner ever resets', () => {
  const tracker = createTracker();
  tracker.observe([frac(1, 5, 'file')], 0);
  assert.equal(tracker.primary().key, 'fraction:file:5', 'the outer signal starts as primary while it is alone');

  // The inner loop ramps past the outer's total and, being same-kind with
  // zero resets so far, would win the plain total-desc tiebreak - but the
  // outer signal was already selected and neither has fewer resets than
  // the other, so it should stay primary through the whole first inner cycle.
  for (let i = 1; i <= 50; i += 1) {
    tracker.observe([frac(i, 100, 'chunk')], i * 10);
    if (i === 1 || i === 25 || i === 50) {
      assert.equal(tracker.primary().key, 'fraction:file:5', `still outer at inner step ${i}`);
    }
  }

  // Once the inner loop actually resets, it falls behind on resets and the
  // (already-primary) outer signal remains the correct choice on that basis too.
  tracker.observe([frac(1, 100, 'chunk')], 510);
  assert.equal(tracker.all().find((s) => s.key === 'fraction:chunk:100').resets, 1);
  assert.equal(tracker.primary().key, 'fraction:file:5');
});

test('primary stickiness does not apply across separate trackers or before any call', () => {
  // Sanity check: a signal only becomes sticky once primary() has actually
  // returned it, not merely by being observed.
  const tracker = createTracker();
  tracker.observe([frac(1, 5, 'small'), frac(1, 100, 'large')], 0);
  assert.equal(tracker.primary().key, 'fraction:large:100', 'first call: plain ranking, larger total wins');
});

test('opts.total ignores fraction/of signals with a different total', () => {
  const tracker = createTracker({ total: 120 });
  tracker.observe([frac(1, 200, 'big'), frac(1, 120, 'good'), pct(50, 'any')], 0);
  assert.deepEqual(tracker.all().map((s) => s.key), ['fraction:good:120', 'percent:any:100']);
});

test('opts.label keeps only signals carrying that label', () => {
  const tracker = createTracker({ label: 'files' });
  tracker.observe([frac(1, 10, 'files'), frac(1, 5, 'other'), pct(10, 'files')], 0);
  assert.deepEqual(tracker.all().map((s) => s.key), ['fraction:files:10', 'percent:files:100']);
});
