import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/signals.js';
import { estimate } from '../src/estimate.js';

// Hand-built Counter matching the shape src/parse.js produces.
const frac = (value, total, label) => ({ kind: 'fraction', value, total, label, raw: '' });
const pct = (value, label) => ({ kind: 'percent', value, total: 100, label, raw: '' });

// In-test log generator: a tick is { t, counters }, t in ms on a fake clock.
function feed(ticks) {
  const tracker = createTracker();
  for (const { t, counters } of ticks) tracker.observe(counters, t);
  return tracker;
}

function steadyTicks(n, dtMs, label) {
  const ticks = [];
  for (let i = 1; i <= n; i++) ticks.push({ t: i * dtMs, counters: [frac(i, n, label)] });
  return ticks;
}

// Step i takes a + b*(i-1) ms: b < 0 accelerates, b > 0 decelerates.
function rampTicks(n, a, b, label) {
  const ticks = [];
  let t = 0;
  for (let i = 1; i <= n; i++) {
    t += a + b * (i - 1);
    ticks.push({ t, counters: [frac(i, n, label)] });
  }
  return ticks;
}

function assertNear(actual, expected, epsilon, message) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: got ${actual}, want ~${expected}`);
}

test('steady log: eta within 10% of truth once fraction >= 0.2', () => {
  const n = 200;
  const dt = 100;
  const tracker = feed(steadyTicks(n, dt, 'step'));
  const primary = tracker.primary();
  assert.equal(primary.key, 'fraction:step:200');
  for (let i = 40; i <= 190; i += 5) {
    const est = estimate(primary, i * dt, 0);
    const truth = ((n - i) * dt) / 1000;
    assertNear(est.etaSeconds, truth, 0.1 * truth, `i=${i}`);
  }
  const done = estimate(primary, n * dt, 0);
  assert.equal(done.fraction, 1);
  assert.equal(done.etaSeconds, 0);
});

test('accelerating log: band contains the truth at fractions 0.3, 0.5, 0.7', () => {
  const n = 200;
  const ticks = rampTicks(n, 220, -0.15, 'block');
  const tracker = feed(ticks);
  const primary = tracker.primary();
  assert.equal(primary.resets, 0);
  const totalS = ticks[n - 1].t / 1000;
  for (const i of [60, 100, 140]) {
    const est = estimate(primary, ticks[i - 1].t, 0);
    const truth = totalS - ticks[i - 1].t / 1000;
    assert.ok(
      est.lowSeconds <= truth && truth <= est.highSeconds,
      `i=${i}: band ${est.lowSeconds}-${est.highSeconds} misses truth ${truth}`
    );
    assert.ok(est.etaSeconds >= truth, `i=${i}: accelerating should finish no later than estimated`);
  }
});

test('decelerating log: band contains the truth at fractions 0.3, 0.5, 0.7', () => {
  const n = 200;
  const ticks = rampTicks(n, 170, 0.15, 'chunk');
  const tracker = feed(ticks);
  const primary = tracker.primary();
  assert.equal(primary.resets, 0);
  const totalS = ticks[n - 1].t / 1000;
  for (const i of [60, 100, 140]) {
    const est = estimate(primary, ticks[i - 1].t, 0);
    const truth = totalS - ticks[i - 1].t / 1000;
    assert.ok(
      est.lowSeconds <= truth && truth <= est.highSeconds,
      `i=${i}: band ${est.lowSeconds}-${est.highSeconds} misses truth ${truth}`
    );
    assert.ok(est.etaSeconds <= truth, `i=${i}: decelerating should finish no sooner than estimated`);
  }
});

test('nested log: primary is the outer fraction, inner percent resets do not win', () => {
  const n = 100;
  const dt = 200;
  const ticks = [];
  for (let i = 1; i <= n; i++) {
    ticks.push({ t: i * dt, counters: [frac(i, n, 'epoch'), pct((((i - 1) % 10) + 1) * 10, 'item')] });
  }
  const tracker = feed(ticks);
  assert.equal(tracker.all().length, 2);
  const primary = tracker.primary();
  assert.equal(primary.key, 'fraction:epoch:100');
  assert.equal(primary.resets, 0);
  const inner = tracker.all().find((s) => s.kind === 'percent');
  assert.equal(inner.key, 'percent:item:100');
  assert.equal(inner.resets, 9);
  const est = estimate(primary, 50 * dt, 0);
  const truth = ((n - 50) * dt) / 1000;
  assertNear(est.etaSeconds, truth, 0.1 * truth, 'nested outer eta at half done');
});

test('decoy-heavy log: resetting percent decoys never win primary', () => {
  const n = 250;
  const dt = 80;
  const ticks = [];
  for (let i = 1; i <= n; i++) {
    ticks.push({
      t: i * dt,
      counters: [
        frac(i, n, 'files'),
        pct((((i - 1) % 10) + 1) * 10, 'chunk'),
        pct((((i - 1) % 7) + 1) * 14, 'phase'),
      ],
    });
  }
  const tracker = feed(ticks);
  assert.equal(tracker.all().length, 3);
  const primary = tracker.primary();
  assert.equal(primary.key, 'fraction:files:250');
  assert.equal(primary.resets, 0);
  for (const i of [50, 125, 200]) {
    const est = estimate(primary, i * dt, 0);
    const truth = ((n - i) * dt) / 1000;
    assertNear(est.etaSeconds, truth, 0.1 * truth, `i=${i}`);
  }
});

test('prior: with no samples the estimate is the prior itself', () => {
  const tracker = feed([]);
  const est = estimate(tracker.primary(), 5000, 0, { medianSeconds: 120, n: 4 });
  assert.equal(est.basis, 'prior');
  assert.equal(est.fraction, null);
  assertNear(est.etaSeconds, 115, 1e-9, 'prior minus elapsed');
  assertNear(est.lowSeconds, 86.25, 1e-9, 'prior band low');
  assertNear(est.highSeconds, 143.75, 1e-9, 'prior band high');
});

test('prior: at fraction 0.075 the estimate is the 50/50 blend', () => {
  const tracker = feed(steadyTicks(200, 100, 'step').slice(0, 15));
  // observed: 185 units left at exactly 10 units/s -> 18.5s; prior remaining: 40 - 1.5 -> 38.5s
  const est = estimate(tracker.primary(), 1500, 0, { medianSeconds: 40, n: 2 });
  assert.equal(est.basis, 'blend');
  assertNear(est.etaSeconds, (18.5 + 38.5) / 2, 1e-6, '50/50 blend');
});
