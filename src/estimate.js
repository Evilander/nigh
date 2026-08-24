// Rate model over a Signal: recent (Theil-Sen) and overall slopes blended into
// an ETA with a widened band, plus human-readable duration formatting.

const RECENT_WINDOW = 20;
const MIN_OVERALL_SPAN_SECONDS = 0.25;
const BLEND_THRESHOLD = 0.15;
const RECENT_WEIGHT = 0.6;
const MIN_BAND_PAD = 0.1;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Theil-Sen slope of value over t, in value units per millisecond.
function theilSenPerMs(samples) {
  const slopes = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const dt = samples[j].t - samples[i].t;
      if (dt > 0) slopes.push((samples[j].value - samples[i].value) / dt);
    }
  }
  return slopes.length === 0 ? null : median(slopes);
}

// Median absolute residual of the Theil-Sen fit over the window, relative to
// the value span of the whole cycle; drives extra band widening on noisy logs.
function residualRatio(window, slopePerMs, total, firstValue) {
  const span = total - firstValue;
  if (slopePerMs === null || !(span > 0)) return 0;
  const intercept = median(window.map((p) => p.value - slopePerMs * p.t));
  const residuals = window.map((p) => Math.abs(slopePerMs * p.t + intercept - p.value));
  return median(residuals) / span;
}

export function estimate(signal, nowMs, startMs, prior = null) {
  const elapsedSeconds = Math.max(0, (nowMs - startMs) / 1000);
  const est = {
    fraction: null,
    elapsedSeconds,
    etaSeconds: null,
    lowSeconds: null,
    highSeconds: null,
    rateRecent: null,
    rateOverall: null,
    basis: 'none',
  };

  // Only samples known as of nowMs count: a signal object may carry samples
  // observed later than the instant being estimated (e.g. a caller replaying
  // a full log and asking "what would the estimate have been at time X").
  const allSamples = signal === null ? [] : signal.samples;
  const samples = allSamples.filter((s) => s.t <= nowMs);
  const n = samples.length;

  let rateOverall = null;
  if (n >= 2) {
    const spanSeconds = (samples[n - 1].t - samples[0].t) / 1000;
    if (spanSeconds >= MIN_OVERALL_SPAN_SECONDS) {
      rateOverall = (samples[n - 1].value - samples[0].value) / spanSeconds;
    }
  }

  const window = samples.slice(Math.max(0, n - RECENT_WINDOW));
  const slopePerMs = n >= 3 ? theilSenPerMs(window) : null;
  const rateRecent = slopePerMs === null ? rateOverall : slopePerMs * 1000;
  est.rateRecent = rateRecent;
  est.rateOverall = rateOverall;
  if (signal !== null && n > 0) {
    est.fraction = signal.kind === 'percent' ? samples[n - 1].value / 100 : samples[n - 1].value / signal.total;
  }

  const remaining = n === 0 ? null : Math.max(0, signal.total - samples[n - 1].value);
  const etaRecent = rateRecent > 0 ? remaining / rateRecent : null;
  const etaOverall = rateOverall > 0 ? remaining / rateOverall : null;

  let observed = null;
  if (etaRecent !== null && etaOverall !== null) {
    observed = {
      eta: RECENT_WEIGHT * etaRecent + (1 - RECENT_WEIGHT) * etaOverall,
      low: Math.min(etaRecent, etaOverall),
      high: Math.max(etaRecent, etaOverall),
    };
  } else if (etaRecent !== null || etaOverall !== null) {
    const solo = etaRecent ?? etaOverall;
    observed = { eta: solo, low: solo, high: solo };
  }
  if (observed !== null) {
    const pad = Math.max(MIN_BAND_PAD, residualRatio(window, slopePerMs, signal.total, samples[0].value));
    observed.low = Math.max(0, observed.low * (1 - pad));
    observed.high = observed.high * (1 + pad);
  }

  const priorRemaining =
    prior === null || prior === undefined ? null : Math.max(0, prior.medianSeconds - elapsedSeconds);

  if (observed === null) {
    if (priorRemaining !== null) {
      est.etaSeconds = priorRemaining;
      est.lowSeconds = 0.75 * priorRemaining;
      est.highSeconds = 1.25 * priorRemaining;
      est.basis = 'prior';
    }
    return est;
  }

  if (priorRemaining !== null && est.fraction < BLEND_THRESHOLD) {
    const w = est.fraction / BLEND_THRESHOLD;
    est.etaSeconds = w * observed.eta + (1 - w) * priorRemaining;
    est.lowSeconds = w * observed.low + (1 - w) * 0.75 * priorRemaining;
    est.highSeconds = w * observed.high + (1 - w) * 1.25 * priorRemaining;
    est.basis = 'blend';
    return est;
  }

  est.etaSeconds = observed.eta;
  est.lowSeconds = observed.low;
  est.highSeconds = observed.high;
  est.basis = 'observed';
  return est;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

export function formatEta(est) {
  if (est.etaSeconds === null || est.etaSeconds === undefined) return 'estimating...';
  if (est.basis === 'prior') return `about ${formatDuration(est.etaSeconds)} (from history)`;
  return `${formatDuration(est.etaSeconds)} left (${formatDuration(est.lowSeconds)}-${formatDuration(est.highSeconds)})`;
}
