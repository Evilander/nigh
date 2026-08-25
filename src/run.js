// Spawns a command, tees its stdout/stderr through unchanged, and drives the
// counter -> signal -> estimate -> render pipeline off of what it prints.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { createLineSplitter, extractCounters } from './parse.js';
import { createTracker } from './signals.js';
import { estimate, formatDuration } from './estimate.js';
import { createStatusLine, normalizeColor, normalizeColorMode, statusText } from './render.js';
import { commandKey, defaultHistoryPath, loadHistory, prior as historyPrior, updateHistory } from './history.js';

const DEFAULT_TICK_MS = 500;
const FORCE_KILL_AFTER_MS = 1000;

// A .cmd/.bat file is not directly executable at the Win32 API level;
// spawning one without `shell: true` throws synchronously (EINVAL). Using
// `shell: true` instead would concatenate argv into an unsafe shell string.
// Batch files still have to pass through cmd.exe, so quote and escape every
// token for cmd's parser and pass the finished command line verbatim.
function isWindowsScript(file) {
  return /\.(cmd|bat)$/i.test(file);
}

function quoteCmdToken(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    const err = new TypeError('newlines are not supported in .cmd/.bat arguments');
    err.code = 'NIGH_USAGE';
    throw err;
  }
  return `"${text.replace(/[\^&|<>()"%!]/g, '^$&')}"`;
}

function spawnMaybeScript(file, args, spawnOptions) {
  if (process.platform === 'win32' && isWindowsScript(file)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const commandLine = `"${[file, ...args].map(quoteCmdToken).join(' ')}"`;
    return spawn(comspec, ['/d', '/v:off', '/s', '/c', commandLine], {
      ...spawnOptions,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, spawnOptions);
}

// spawn() reports a missing executable asynchronously via 'error', not by
// throwing; on win32 a bare command (no extension) commonly needs the
// ".cmd" shim (npm, npx, and friends are installed that way). Both spawn
// attempts are wrapped in try/catch: a .cmd/.bat target (explicit, or via
// the retry appending ".cmd") throws synchronously rather than emitting
// 'error', and an uncaught throw here would crash the whole process instead
// of surfacing as the ordinary "command not found"-style error bin/nigh.js
// already handles.
function spawnWithRetry(file, args, spawnOptions) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnMaybeScript(file, args, spawnOptions);
    } catch (err) {
      reject(err);
      return;
    }
    let retried = false;
    function onError(err) {
      if (!retried && process.platform === 'win32' && err && err.code === 'ENOENT') {
        retried = true;
        child.removeListener('error', onError);
        child.removeListener('spawn', onSpawn);
        try {
          child = spawnMaybeScript(`${file}.cmd`, args, spawnOptions);
        } catch (retryErr) {
          reject(retryErr);
          return;
        }
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

// Best-effort whole-tree termination. A plain child.kill() only reaches the
// direct child, so a wrapped shell/script's own children (e.g.
// `nigh -- sh -c "long-running-thing"`) can outlive nigh. On POSIX the child
// is spawned detached into its own process group (see the spawn options
// below), so a negative pid signals the whole group. Windows has no
// equivalent via child.kill(); this shells out to the built-in taskkill
// /T (tree) /F (force) instead.
export function killTree(child, signal) {
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      if (!result.error && result.status === 0) return;
    } catch {
      // taskkill itself unavailable: fall through to a direct kill below.
    }
  } else {
    try {
      process.kill(-child.pid, signal); // negative pid: the whole process group
      return;
    } catch {
      // no such group (e.g. child already gone): fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // child already gone; nothing to signal.
  }
}

function scheduleForceKill(child) {
  if (process.platform === 'win32') return null;
  const timer = setTimeout(() => {
    killTree(child, 'SIGKILL');
  }, FORCE_KILL_AFTER_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// Wraps a destination Writable so that (1) EPIPE and other destination
// errors are swallowed instead of crashing the process - once one happens,
// further writes to that destination are silently dropped rather than
// re-throwing or spamming - and (2), when `source` is given, writes honour
// backpressure by pausing it until the destination drains. `source` is the
// upstream Readable being copied through this destination, if any; it is
// what needs to pause when the destination cannot keep up.
export function createSink(destStream, source, onBroken) {
  let broken = false;
  function markBroken() {
    if (broken) return;
    broken = true;
    if (source && typeof source.isPaused === 'function' && source.isPaused()) {
      try {
        source.resume();
      } catch {
        // The destination is already broken; resuming is best-effort cleanup.
      }
    }
    if (onBroken) onBroken();
  }
  // destStream is documented as a Writable, but tests commonly pass a
  // minimal { write() } double with no event emitter behind it; only wire
  // up 'error'/'drain' handling when there is one to listen on.
  if (typeof destStream.on === 'function') {
    destStream.on('error', markBroken);
    if (source) {
      destStream.on('drain', () => {
        if (source.isPaused()) source.resume();
      });
    }
  }
  return function write(chunk) {
    if (broken) return;
    try {
      const ok = destStream.write(chunk);
      if (ok === false && source) source.pause();
    } catch {
      markBroken();
    }
  };
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
    barColor,
    trackColor,
    colorMode,
    statusIsTTY,
    stdout = process.stdout,
    stderr = process.stderr,
    statusStream = null,
    now = Date.now,
    env,
  } = opts;

  const normalizedBarColor = normalizeColor(barColor, '--bar-color');
  const normalizedTrackColor = normalizeColor(trackColor, '--track-color');
  const normalizedColorMode = normalizeColorMode(colorMode);
  const startMs = now();
  const tracker = createTracker({ experimental, total, label });

  const historyPath = historyFile === undefined ? defaultHistoryPath() : historyFile;
  const historyEnabled = historyPath !== 'off';
  const key = commandKey(argv);
  const priorEstimate = historyEnabled ? historyPrior(loadHistory(historyPath), key) : null;

  const child = await spawnWithRetry(argv[0], argv.slice(1), {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: env ?? process.env,
  });

  let pipeBroke = false;
  let forceKillTimer = null;
  function requestChildTermination(signal) {
    killTree(child, signal);
    if ((signal === 'SIGINT' || signal === 'SIGTERM') && forceKillTimer === null) {
      forceKillTimer = scheduleForceKill(child);
    }
  }
  function markChildPipeBroken() {
    pipeBroke = true;
    requestChildTermination('SIGTERM');
  }
  function clearForceKillTimer() {
    if (forceKillTimer !== null) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  }

  // Where nigh's own output (status line, JSON events, the final summary)
  // goes. By default that's stderr, shared with the child's own stderr
  // bytes; statusStream (bin/nigh.js's --status-fd / --status-file) gives
  // that a separate home so stderr carries only the child, byte for byte.
  // When stderr is shared, the sink that writes to it is also the pause
  // point for the child's stderr stream; when it is not, nothing
  // child-related flows through the status destination, so there is
  // nothing to pause there.
  const statusDest = statusStream ?? stderr;
  const writeStatus = createSink(
    statusDest,
    statusStream ? null : child.stderr,
    statusStream ? null : markChildPipeBroken,
  );
  const statusTTY = statusIsTTY === undefined ? Boolean(statusDest.isTTY) : Boolean(statusIsTTY);
  const statusLine = json ? null : createStatusLine({ write: writeStatus }, { isTTY: statusTTY, intervalMs, now });
  const colorEnabled = !json && (normalizedColorMode === 'always' || (normalizedColorMode === 'auto' && statusTTY));

  function writeJsonEvent(obj) {
    writeStatus(`${JSON.stringify(obj)}\n`);
  }

  if (json) writeJsonEvent({ event: 'start', argv, pid: child.pid, t: 0 });

  const outSplitter = createLineSplitter();
  const errSplitter = createLineSplitter();

  function handleLines(lines, t) {
    for (const line of lines) {
      const counters = extractCounters(line);
      if (counters.length === 0) continue;
      const hadSignals = tracker.all().length > 0;
      tracker.observe(counters, t);
      if (json) writeJsonEvent({ event: 'counter', line, counters, t: t - startMs });
      if (!hadSignals && tracker.all().length > 0) tick();
    }
  }

  // A broken stdout means nobody is reading any more (`nigh -- cmd | head -1`).
  // Without this the child keeps producing into a pipe nigh alone still drains,
  // so the pipeline never ends - a plain `cmd | head -1` would have died of
  // SIGPIPE immediately. Stop the child tree and report the conventional 141.
  const writeStdout = createSink(stdout, child.stdout, () => {
    markChildPipeBroken();
  });
  child.stdout.on('data', (chunk) => {
    writeStdout(chunk);
    handleLines(outSplitter.push(chunk), now());
  });

  // Raw stderr sink: only needed when statusStream keeps the status channel
  // separate, so the child's own bytes go straight through instead of via
  // the status line's clear/redraw dance.
  const writeStderrRaw = statusStream ? createSink(stderr, child.stderr, markChildPipeBroken) : null;
  child.stderr.on('data', (chunk) => {
    if (writeStderrRaw) writeStderrRaw(chunk);
    else if (statusLine) statusLine.passthrough(chunk);
    else writeStatus(chunk); // json mode sharing stderr: raw bytes interleave with JSON events
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
      barColor: normalizedBarColor,
      trackColor: normalizedTrackColor,
      colorEnabled,
    });
    statusLine.update(text);
  }
  const timer = setInterval(tick, tickMs);

  const handledSignals = ['SIGINT', 'SIGTERM'];
  let receivedSignal = null;
  const signalHandlers = handledSignals.map((sig) => {
    const handler = () => {
      receivedSignal = sig;
      requestChildTermination(sig);
    };
    process.on(sig, handler);
    return [sig, handler];
  });

  return new Promise((resolve) => {
    child.once('close', async (code, signal) => {
      clearInterval(timer);
      clearForceKillTimer();
      for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);

      const finishedMs = now();
      // Parse whatever unterminated text is left in either splitter before
      // the final estimate: a child that exits right after e.g.
      // process.stdout.write("10/10") with no trailing newline would
      // otherwise never have that last counter observed.
      handleLines(outSplitter.flush(), finishedMs);
      handleLines(errSplitter.flush(), finishedMs);

      const durationSeconds = Math.max(0, (finishedMs - startMs) / 1000);
      // 141 is the conventional "died of SIGPIPE" status; Windows has no
      // SIGPIPE in os.constants, so the number is spelled out.
      const exitCode = pipeBroke
        ? 141
        : receivedSignal ? 128 + (os.constants.signals[receivedSignal] ?? 0)
          : signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0);
      const primary = tracker.primary();
      const finalEstimate = estimate(primary, finishedMs, startMs, priorEstimate);

      if (json) {
        writeJsonEvent({ event: 'exit', exitCode, durationSeconds });
      } else {
        statusLine.done(doneText(primary, durationSeconds));
      }

      if (historyEnabled) {
        try {
          await updateHistory(historyPath, key, {
            durationSeconds,
            total: primary ? primary.total : null,
            finishedAt: new Date().toISOString(),
            exitCode,
          });
        } catch {
          // history is a convenience, not a correctness requirement: a
          // write failure (e.g. a read-only home dir) must not fail the run.
        }
      }

      resolve({ exitCode, durationSeconds, primary, finalEstimate });
    });
  });
}
