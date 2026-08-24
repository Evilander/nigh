import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, formatDuration, formatEta } from '../src/estimate.js';

const pt = (t, value) => ({ t, value });

// Hand-built Signal matching the shape src/signals.js produces.
function sig(samples, total = 100, kind = 'fraction', label = '') {
  return {
    key: `${kind}:${label}:${total}`,
    kind,
    label,
    total,
    samples,
    resets: 0,
    first: samples[0],
    last: samples[samples.length - 1],
    fraction() {
      const v = samples[samples.length - 1].value;
      return kind === 'percent' ? v / 100 : v / total;
    },
  };
}

function near(actual, expected, epsilon = 1e-9, message = '') {
  assert.ok(Math.abs(actual - expected) < epsilon, `${message} got ${actual}, want ~${expected}`);
}

test('no signal and no prior: basis none with null estimates', () => {
  const est = estimate(null, 5000, 0);
  assert.equal(est.basis, 'none');
  assert.equal(est.fraction, null);
  assert.equal(est.etaSeconds, null);
  assert.equal(est.lowSeconds, null);
  assert.equal(est.highSeconds, null);
  assert.equal(est.rateRecent, null);
  assert.equal(est.rateOverall, null);
  near(est.elapsedSeconds, 5);
});

test('no signal with a prior: basis prior with a +-25% band', () => {
  const est = estimate(null, 10000, 0, { medianSeconds: 100, n: 3 });
  assert.equal(est.basis, 'prior');
  assert.equal(est.fraction, null);
  near(est.etaSeconds, 90);
  near(est.lowSeconds, 67.5);
  near(est.highSeconds, 112.5);
});

test('rateOverall needs two samples spanning at least 250ms', () => {
  const short = estimate(sig([pt(0, 0), pt(100, 1)]), 100, 0);
  assert.equal(short.rateOverall, null);
  assert.equal(short.basis, 'none');

  const ok = estimate(sig([pt(0, 0), pt(300, 3)], 30), 300, 0);
  near(ok.rateOverall, 10);
  assert.equal(ok.rateRecent, ok.rateOverall);
  assert.equal(ok.basis, 'observed');
  near(ok.etaSeconds, 2.7, 1e-9, 'remaining 27 units at 10/s'); // point eta is not widened
  near(ok.lowSeconds, 2.7 * 0.9);
  near(ok.highSeconds, 2.7 * 1.1);
});

test('Theil-Sen resists an outlier that drags the overall rate', () => {
  const est = estimate(sig([pt(0, 0), pt(1000, 10), pt(2000, 20), pt(3000, 90)], 200), 3000, 0);
  near(est.rateRecent, 20);
  near(est.rateOverall, 30);
  near(est.etaSeconds, 0.6 * 5.5 + 0.4 * (110 / 30), 1e-9, 'weighted blend of both rates'); // remaining 110
  near(est.lowSeconds, (110 / 30) * 0.9);
  near(est.highSeconds, 5.5 * 1.1);
  assert.equal(est.basis, 'observed');
  near(est.fraction, 0.45);
});

test('rateRecent only looks at the last min(20, n) samples', () => {
  const samples = [pt(0, 500)]; // ancient outlier outside the recent window
  for (let i = 1; i <= 20; i++) samples.push(pt(i * 1000, i));
  const est = estimate(sig(samples, 400), 20000, 0);
  near(est.rateRecent, 1);
});

test('a flat signal has no usable rate', () => {
  const est = estimate(sig([pt(0, 5), pt(1000, 5), pt(2000, 5)]), 2000, 0);
  near(est.rateRecent, 0);
  assert.equal(est.basis, 'none');
  assert.equal(est.etaSeconds, null);
});

test('an unusable signal falls back to the prior', () => {
  const est = estimate(sig([pt(0, 0), pt(100, 1)]), 100, 0, { medianSeconds: 60, n: 1 });
  assert.equal(est.basis, 'prior');
  near(est.etaSeconds, 59.9);
});

test('steady signal gets an exact eta', () => {
  const samples = [];
  for (let i = 1; i <= 20; i++) samples.push(pt(i * 1000, i));
  const est = estimate(sig(samples, 200), 20000, 0);
  assert.equal(est.basis, 'observed');
  // 1 unit per 1000ms of t: same generation pattern as the "last min(20, n)"
  // test above, which independently confirms rate 1 (not the 10 this test
  // originally asserted — remaining 180 units at rate 1/s is 180s, not 18s).
  near(est.rateRecent, 1);
  near(est.rateOverall, 1);
  near(est.etaSeconds, 180, 1e-6);
});

test('blend weights observed vs prior by fraction/0.15', () => {
  // fraction 15/200 = 0.075 -> w = 0.5; rates 7.5/s -> observed 185/7.5; prior remaining 40-2 = 38
  const est = estimate(sig([pt(0, 0), pt(1000, 10), pt(2000, 15)], 200), 2000, 0, { medianSeconds: 40, n: 2 });
  assert.equal(est.basis, 'blend');
  near(est.etaSeconds, (185 / 7.5 + 38) / 2);
  assert.ok(est.lowSeconds <= est.etaSeconds && est.etaSeconds <= est.highSeconds);
});

test('fraction at or above 0.15 ignores the prior', () => {
  const est = estimate(sig([pt(0, 0), pt(1000, 10), pt(2000, 31)], 200), 2000, 0, { medianSeconds: 99999, n: 5 });
  assert.equal(est.basis, 'observed');
  assert.ok(est.etaSeconds < 9999);
});

test('a finished signal reports eta 0', () => {
  const est = estimate(sig([pt(0, 0), pt(1000, 50), pt(2000, 100)]), 2000, 0);
  assert.equal(est.fraction, 1);
  assert.equal(est.etaSeconds, 0);
  assert.equal(est.basis, 'observed');
});

test('formatDuration renders each magnitude', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(45.4), '45s');
  assert.equal(formatDuration(59.7), '1m00s');
  assert.equal(formatDuration(190), '3m10s');
  assert.equal(formatDuration(240), '4m00s');
  assert.equal(formatDuration(3600), '1h00m');
  assert.equal(formatDuration(3720), '1h02m');
  assert.equal(formatDuration(183600), '2d03h');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(0), '0s');
});

test('formatEta covers every basis', () => {
  assert.equal(
    formatEta({ basis: 'observed', etaSeconds: 190, lowSeconds: 160, highSeconds: 240 }),
    '3m10s left (2m40s-4m00s)'
  );
  assert.equal(
    formatEta({ basis: 'blend', etaSeconds: 190, lowSeconds: 160, highSeconds: 240 }),
    '3m10s left (2m40s-4m00s)'
  );
  assert.equal(formatEta({ basis: 'prior', etaSeconds: 290 }), 'about 4m50s (from history)');
  assert.equal(formatEta({ basis: 'none', etaSeconds: null }), 'estimating...');
});
