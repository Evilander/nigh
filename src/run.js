// Spawns a command, tees its stdout/stderr through unchanged, and drives the
// counter -> signal -> estimate -> render pipeline off of what it prints.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createLineSplitter, extractCounters } from './parse.js';
import { createTracker } from './signals.js';
import { estimate, formatDuration } from './estimate.js';
import { createStatusLine, statusText } from './render.js';
import { commandKey, defaultHistoryPath, loadHistory, recordRun, prior as historyPrior, saveHistory } from './history.js';

const DEFAULT_TICK_MS = 500;

// spawn() reports a missing executable asynchronously via 'error', not by
// throwing; on win32 a bare command (no extension) commonly needs the
// ".cmd" shim (npm, npx, and friends are installed that way).
function spawnWithRetry(file, args, spawnOptions) {
  return new Promise((resolve, reject) => {
    let child = spawn(file, args, spawnOptions);
    let retried = false;
    function onError(err) {
      if (!retried && process.platform === 'win32' && err && err.code === 'ENOENT') {
        retried = true;
        child.removeListener('error', onError);
        child.removeListener('spawn', onSpawn);
        child = spawn(`${file}.cmd`, args, spawnOptions);
        child.once('error', reject);
        child.once('spawn', () => resolve(child));
        return;
      }
      reject(err);
    }
    function onSpawn() {
      resolve(child);
    }
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

function estimateSignature(est) {
  const round = (v, places) => (v === null || v === undefined ? null : Math.round(v * 10 ** places) / 10 ** places);
  return JSON.stringify({
    fraction: round(est.fraction, 3),
    etaSeconds: round(est.etaSeconds, 0),
    lowSeconds: round(est.lowSeconds, 0),
    highSeconds: round(est.highSeconds, 0),
    basis: est.basis,
  });
}

function doneText(primary, durationSeconds) {
  const base = `done in ${formatDuration(durationSeconds)}`;
  if (!primary) return base;
  const prefix = primary.label ? `${primary.label} ` : '';
  return `${base} · counter ${prefix}${primary.last.value}/${primary.total}`;
}

export async function run(argv, opts = {}) {
  const {
    json = false,
    quiet = false,
    intervalMs,
    tickMs = DEFAULT_TICK_MS,
    historyFile,
    experimental = false,
    total = null,
    label = null,
    ascii = false,
    stdout = process.stdout,
    stderr = process.stderr,
    now = Date.now,
    env,
  } = opts;

  const startMs = now();
  const tracker = createTracker({ experimental, total, label });

  const historyPath = historyFile === undefined ? defaultHistoryPath() : historyFile;
  const historyEnabled = historyPath !== 'off';
  const key = commandKey(argv);
  let history = null;
  let priorEstimate = null;
  if (historyEnabled) {
    history = loadHistory(historyPath);
    priorEstimate = historyPrior(history, key);
  }

  const statusLine = json ? null : createStatusLine(stderr, { isTTY: Boolean(stderr.isTTY), intervalMs, now });

  function writeJsonEvent(obj) {
    stderr.write(`${JSON.stringify(obj)}\n`);
  }

  const child = await spawnWithRetry(argv[0], argv.slice(1), {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    env: env ?? process.env,
  });

  if (json) writeJsonEvent({ event: 'start', argv, pid: child.pid, t: 0 });

  const outSplitter = createLineSplitter();
  const errSplitter = createLineSplitter();

  function handleLines(lines, t) {
    for (const line of lines) {
      const counters = extractCounters(line);
      if (counters.length === 0) continue;
      tracker.observe(counters, t);
      if (json) writeJsonEvent({ event: 'counter', line, counters, t: t - startMs });
    }
  }

  child.stdout.on('data', (chunk) => {
    stdout.write(chunk);
    handleLines(outSplitter.push(chunk), now());
  });

  child.stderr.on('data', (chunk) => {
    if (statusLine) statusLine.passthrough(chunk);
    else stderr.write(chunk);
    handleLines(errSplitter.push(chunk), now());
  });

  let lastEstimateSignature = null;
  function tick() {
    const primary = tracker.primary();
    const est = estimate(primary, now(), startMs, priorEstimate);
    if (json) {
      const sig = estimateSignature(est);
      if (sig !== lastEstimateSignature) {
        lastEstimateSignature = sig;
        writeJsonEvent({
          event: 'estimate',
          fraction: est.fraction,
          etaSeconds: est.etaSeconds,
          lowSeconds: est.lowSeconds,
          highSeconds: est.highSeconds,
          basis: est.basis,
          t: now() - startMs,
        });
      }
      return;
    }
    if (quiet) return;
    const text = statusText({
      fraction: est.fraction,
      est,
      label: primary ? primary.label : '',
      value: primary ? primary.last.value : null,
      total: primary ? primary.total : null,
      ascii,
    });
    statusLine.update(text);
  }
  const timer = setInterval(tick, tickMs);

  const forwarded = ['SIGINT', 'SIGTERM'];
  const signalHandlers = forwarded.map((sig) => {
    const handler = () => {
      try {
        child.kill(sig);
      } catch {
        // child may already be gone; nothing to forward to.
      }
    };
    process.on(sig, handler);
    return [sig, handler];
  });

  return new Promise((resolve) => {
    child.once('close', (code, signal) => {
      clearInterval(timer);
      for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);

      const finishedMs = now();
      const durationSeconds = Math.max(0, (finishedMs - startMs) / 1000);
      const exitCode = signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0);
      const primary = tracker.primary();
      const finalEstimate = estimate(primary, finishedMs, startMs, priorEstimate);

      if (json) {
        writeJsonEvent({ event: 'exit', exitCode, durationSeconds });
      } else {
        statusLine.done(doneText(primary, durationSeconds));
      }

      if (historyEnabled) {
        history = recordRun(history, key, {
          durationSeconds,
          total: primary ? primary.total : null,
          finishedAt: new Date().toISOString(),
        });
        try {
          saveHistory(history, historyPath);
        } catch {
          // history is a convenience, not a correctness requirement: a
          // write failure (e.g. a read-only home dir) must not fail the run.
        }
      }

      resolve({ exitCode, durationSeconds, primary, finalEstimate });
    });
  });
}
