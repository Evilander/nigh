import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import * as historyModule from '../src/history.js';

const {
  commandKey,
  defaultHistoryPath,
  loadHistory,
  recordRun,
  prior,
  saveHistory,
} = historyModule;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nigh-history-test-'));
}

function historyLockPath(file) {
  return `${file}.lock`;
}

function waitForWorker(worker) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    }
    function cleanup() {
      worker.off('message', onMessage);
      worker.off('error', finish);
      worker.off('exit', onExit);
    }
    function onMessage(message) {
      if (!Object.hasOwn(message, 'ok')) return;
      if (message.ok) finish();
      else finish(new Error(message.stack || message.message || 'worker update failed'));
    }
    function onExit(code) {
      if (code !== 0) finish(new Error(`worker exited with ${code}`));
    }
    worker.on('message', onMessage);
    worker.once('error', finish);
    worker.once('exit', onExit);
  });
}

function waitForWorkerEvent(worker, event) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(err, message) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(message);
    }
    function cleanup() {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    }
    function onMessage(message) {
      if (message.event === event) finish(null, message);
      else if (Object.hasOwn(message, 'ok') && !message.ok) {
        finish(new Error(message.stack || message.message || 'worker update failed'));
      }
    }
    function onError(err) {
      finish(err);
    }
    function onExit(code) {
      if (code !== 0) finish(new Error(`worker exited with ${code}`));
    }
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

function startHistoryWorker({ file, key, run, opts, gate }) {
  const historyUrl = pathToFileURL(path.resolve('src/history.js')).href;
  return new Worker(
    `
      import { parentPort, workerData } from 'node:worker_threads';
      import * as historyModule from ${JSON.stringify(historyUrl)};

      const gate = new Int32Array(workerData.gate);
      Atomics.wait(gate, 0, 0);

      try {
        if (typeof historyModule.updateHistory !== 'function') {
          throw new Error('updateHistory is not exported');
        }
        await historyModule.updateHistory(workerData.file, workerData.key, workerData.run, workerData.opts);
        parentPort.postMessage({ ok: true });
      } catch (err) {
        parentPort.postMessage({ ok: false, message: err?.message, stack: err?.stack });
      }
    `,
    { eval: true, type: 'module', workerData: { file, key, run, opts, gate } },
  );
}

function startBlockingHistoryWorker({ file, key, durationSeconds, opts, gate }) {
  const historyUrl = pathToFileURL(path.resolve('src/history.js')).href;
  return new Worker(
    `
      import { parentPort, workerData } from 'node:worker_threads';
      import { updateHistory } from ${JSON.stringify(historyUrl)};

      const gate = new Int32Array(workerData.gate);
      const run = {
        durationSeconds: workerData.durationSeconds,
        total: null,
        finishedAt: workerData.finishedAt,
        exitCode: 0,
        toJSON() {
          parentPort.postMessage({ event: 'save-started' });
          Atomics.wait(gate, 0, 0);
          return {
            durationSeconds: workerData.durationSeconds,
            total: null,
            finishedAt: workerData.finishedAt,
            exitCode: 0,
          };
        },
      };

      try {
        await updateHistory(workerData.file, workerData.key, run, workerData.opts);
        parentPort.postMessage({ ok: true });
      } catch (err) {
        parentPort.postMessage({ ok: false, message: err?.message, stack: err?.stack });
      }
    `,
    {
      eval: true,
      type: 'module',
      workerData: {
        file,
        key,
        durationSeconds,
        finishedAt: `t${durationSeconds}`,
        opts,
        gate,
      },
    },
  );
}

function openWorkerGate(gate) {
  const view = new Int32Array(gate);
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
}

test('commandKey encodes argv as a JSON array and digit-collapses for the shape', () => {
  const key = commandKey(['make', '-j8', 'target2']);
  assert.equal(key.exact, '["make","-j8","target2"]');
  assert.equal(key.shape, '["make","-j#","target#"]');
});

test('commandKey with no digits has identical exact and shape keys', () => {
  const key = commandKey(['make', 'target']);
  assert.equal(key.exact, '["make","target"]');
  assert.equal(key.shape, key.exact);
});

// The bug this guards against: space-joining argv made ['a b', 'c'] and
// ['a', 'b c'] collide on the same history key, silently mixing two
// unrelated commands' durations into one prior.
test('commandKey does not collide when a space moves between argv elements', () => {
  const keyA = commandKey(['a b', 'c']);
  const keyB = commandKey(['a', 'b c']);
  assert.notEqual(keyA.exact, keyB.exact);
});

test('defaultHistoryPath honours NIGH_HISTORY', () => {
  const prev = process.env.NIGH_HISTORY;
  process.env.NIGH_HISTORY = path.join('some', 'file.json');
  try {
    assert.equal(defaultHistoryPath(), path.join('some', 'file.json'));
  } finally {
    if (prev === undefined) delete process.env.NIGH_HISTORY;
    else process.env.NIGH_HISTORY = prev;
  }
});

test('defaultHistoryPath falls back to ~/.config/nigh/history.json', () => {
  const prev = process.env.NIGH_HISTORY;
  delete process.env.NIGH_HISTORY;
  try {
    assert.equal(
      defaultHistoryPath(),
      path.join(os.homedir(), '.config', 'nigh', 'history.json'),
    );
  } finally {
    if (prev !== undefined) process.env.NIGH_HISTORY = prev;
  }
});

test('loadHistory returns {} for a missing file', () => {
  const dir = tmpDir();
  assert.deepEqual(loadHistory(path.join(dir, 'missing.json')), {});
});

test('loadHistory returns {} for a corrupt file and does not throw', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file, '{ "make": { runs: [ truncated');
  assert.deepEqual(loadHistory(file), {});
});

test('loadHistory treats a valid-JSON but wrong-shaped entry as absent, not a crash', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  // The reviewer's exact repro: runs is a string, not an array.
  fs.writeFileSync(file, JSON.stringify({ make: { runs: 'oops' } }));
  assert.deepEqual(loadHistory(file), {});
});

test('loadHistory keeps well-shaped runs and drops individually malformed ones within the same entry', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      make: {
        runs: [
          { durationSeconds: 5, total: null, finishedAt: 't1' },
          'not a run object',
          { durationSeconds: -1, total: null, finishedAt: 't2' }, // negative duration
          { total: null, finishedAt: 't3' }, // missing durationSeconds
          { durationSeconds: 9, total: null, finishedAt: 't4' },
        ],
      },
    }),
  );
  const loaded = loadHistory(file);
  assert.deepEqual(loaded.make.runs.map((r) => r.durationSeconds), [5, 9]);
});

test('loadHistory round-trips what saveHistory wrote', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const history = { 'make -j8': { runs: [{ durationSeconds: 12, total: null, finishedAt: '2026-01-01T00:00:00Z' }] } };
  saveHistory(history, file);
  assert.deepEqual(loadHistory(file), history);
});

test('recordRun records under both exact and shape keys and returns the same object', () => {
  const history = {};
  const key = commandKey(['make', '-j8', 'target2']);
  const run = { durationSeconds: 30, total: null, finishedAt: '2026-01-01T00:00:00Z' };
  const returned = recordRun(history, key, run);
  assert.equal(returned, history);
  assert.deepEqual(history[key.exact].runs, [run]);
  assert.deepEqual(history[key.shape].runs, [run]);
});

test('recordRun keeps at most 20 runs per key, dropping the oldest', () => {
  const history = {};
  const key = commandKey(['make', '-j8', 'target2']);
  for (let i = 1; i <= 25; i++) {
    recordRun(history, key, { durationSeconds: i, total: null, finishedAt: '2026-01-01T00:00:00Z' });
  }
  assert.equal(history[key.exact].runs.length, 20);
  assert.equal(history[key.exact].runs[0].durationSeconds, 6);
  assert.equal(history[key.exact].runs[19].durationSeconds, 25);
  assert.deepEqual(history[key.shape].runs, history[key.exact].runs);
});

test('recordRun records once when exact and shape keys are identical', () => {
  const history = {};
  const key = commandKey(['make', 'target']);
  recordRun(history, key, { durationSeconds: 5, total: null, finishedAt: '2026-01-01T00:00:00Z' });
  assert.equal(history[key.exact].runs.length, 1);
});

test('prior prefers the exact key over the shape key', () => {
  const key = { exact: 'make -j2 all', shape: 'make -j# all' };
  const history = {
    [key.exact]: { runs: [{ durationSeconds: 2 }, { durationSeconds: 4 }] },
    [key.shape]: { runs: [{ durationSeconds: 100 }] },
  };
  assert.deepEqual(prior(history, key), { medianSeconds: 3, n: 2 });
});

test('prior falls back to the shape key and takes the median (odd count)', () => {
  const key = { exact: 'rsync -a x y', shape: 'rsync -a # #' };
  const history = {
    [key.exact]: { runs: [] },
    [key.shape]: { runs: [{ durationSeconds: 40 }, { durationSeconds: 10 }, { durationSeconds: 20 }] },
  };
  assert.deepEqual(prior(history, key), { medianSeconds: 20, n: 3 });
});

test('prior returns null when neither key has runs', () => {
  const key = { exact: 'gone', shape: 'gone' };
  assert.equal(prior({}, key), null);
  assert.equal(prior({ [key.exact]: { runs: [] } }, key), null);
});

test('prior excludes nonzero-exit and signal-killed runs from the median', () => {
  const key = { exact: 'flaky', shape: 'flaky' };
  const history = {
    [key.exact]: {
      runs: [
        { durationSeconds: 10, exitCode: 0 },
        { durationSeconds: 999, exitCode: 3 }, // failed: must not poison the prior
        { durationSeconds: 998, exitCode: 130 }, // 128 + SIGINT: also excluded
        { durationSeconds: 20, exitCode: 0 },
      ],
    },
  };
  assert.deepEqual(prior(history, key), { medianSeconds: 15, n: 2 });
});

test('prior treats runs with no exitCode field (older history files) as ok', () => {
  const key = { exact: 'legacy', shape: 'legacy' };
  const history = { [key.exact]: { runs: [{ durationSeconds: 10 }, { durationSeconds: 20 }] } };
  assert.deepEqual(prior(history, key), { medianSeconds: 15, n: 2 });
});

test('prior returns null when every run for a key failed', () => {
  const key = { exact: 'always-fails', shape: 'always-fails' };
  const history = { [key.exact]: { runs: [{ durationSeconds: 5, exitCode: 1 }] } };
  assert.equal(prior(history, key), null);
});

test('saveHistory creates missing parent directories', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'dirs', 'history.json');
  saveHistory({ a: { runs: [] } }, file);
  assert.deepEqual(loadHistory(file), { a: { runs: [] } });
});

test('saveHistory writes via a unique tmp sibling, renames over the file, and leaves no tmp files behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');

  saveHistory({ first: { runs: [] } }, file);
  assert.deepEqual(loadHistory(file), { first: { runs: [] } });
  assert.deepEqual(fs.readdirSync(dir), ['history.json'], 'no leftover tmp files after a save');

  saveHistory({ second: { runs: [] } }, file);
  assert.deepEqual(loadHistory(file), { second: { runs: [] } });
  assert.deepEqual(fs.readdirSync(dir), ['history.json']);
});

test('a fresh reload before recording avoids losing a concurrently written run', () => {
  // Models the pattern src/run.js now uses at close time: reload the current
  // on-disk history right before merging in this run's own record, instead
  // of reusing the copy loaded back at start. Two "processes" that both
  // started from an empty history should both end up recorded, not just
  // whichever saved last.
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const key = commandKey(['make']);

  loadHistory(file); // process A's start-of-run load (empty)
  loadHistory(file); // process B's start-of-run load (also empty)

  // Process A finishes first: reload fresh, record, save.
  const freshA = loadHistory(file);
  saveHistory(recordRun(freshA, key, { durationSeconds: 10, total: null, finishedAt: 't1', exitCode: 0 }), file);

  // Process B finishes second. If it merged its own stale start-of-run
  // snapshot instead of reloading, this save would silently drop A's run.
  const freshB = loadHistory(file);
  saveHistory(recordRun(freshB, key, { durationSeconds: 20, total: null, finishedAt: 't2', exitCode: 0 }), file);

  const final = loadHistory(file);
  assert.equal(final[key.exact].runs.length, 2, 'both runs should survive, not just the last writer');
  assert.deepEqual(final[key.exact].runs.map((r) => r.durationSeconds), [10, 20]);
});

test('updateHistory preserves every concurrent run up to the run cap', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const key = commandKey(['make']);
  const gate = new SharedArrayBuffer(4);
  const workers = [];
  const completions = [];

  for (let i = 1; i <= 20; i++) {
    const worker = startHistoryWorker({
      file,
      key,
      run: { durationSeconds: i, total: null, finishedAt: `t${i}`, exitCode: 0 },
      opts: { timeoutMs: 3000, retryMs: 1, staleMs: 60_000 },
      gate,
    });
    workers.push(worker);
    completions.push(waitForWorker(worker));
  }

  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workers.length);
  await Promise.all(completions);

  const final = loadHistory(file);
  assert.deepEqual(
    final[key.exact].runs.map((r) => r.durationSeconds).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  assert.equal(fs.existsSync(historyLockPath(file)), false);
});

test('updateHistory recovers a genuinely stale sibling lock', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const lock = historyLockPath(file);
  const key = commandKey(['make']);
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  await historyModule.updateHistory(
    file,
    key,
    { durationSeconds: 7, total: null, finishedAt: 't7', exitCode: 0 },
    { timeoutMs: 1000, retryMs: 1, staleMs: 10 },
  );

  assert.deepEqual(loadHistory(file)[key.exact].runs.map((r) => r.durationSeconds), [7]);
  assert.equal(fs.existsSync(lock), false);
});

test('updateHistory retries a transient Windows permission race while inspecting a lock', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const lock = historyLockPath(file);
  const key = commandKey(['make']);
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  const realReaddirSync = fs.readdirSync;
  let injected = false;
  fs.readdirSync = function readdirWithOnePermissionRace(target, ...args) {
    if (!injected && path.resolve(target) === path.resolve(lock)) {
      injected = true;
      const err = new Error('transient lock race');
      err.code = 'EPERM';
      throw err;
    }
    return realReaddirSync.call(this, target, ...args);
  };

  try {
    await historyModule.updateHistory(
      file,
      key,
      { durationSeconds: 8, total: null, finishedAt: 't8', exitCode: 0 },
      { timeoutMs: 1000, retryMs: 1, staleMs: 10 },
    );
  } finally {
    fs.readdirSync = realReaddirSync;
  }

  assert.equal(injected, true);
  assert.deepEqual(loadHistory(file)[key.exact].runs.map((r) => r.durationSeconds), [8]);
  assert.equal(fs.existsSync(lock), false);
});

test('updateHistory retries transient Windows lock mkdir errors as contention', async () => {
  const codes = ['EPERM', 'EACCES', 'EBUSY'];

  for (const [index, code] of codes.entries()) {
    const dir = tmpDir();
    const file = path.join(dir, 'history.json');
    const lock = historyLockPath(file);
    const key = commandKey(['make', code]);
    const realMkdirSync = fs.mkdirSync;
    let injections = 0;

    fs.mkdirSync = function mkdirWithOneTransientLockError(target, ...args) {
      if (injections === 0 && path.resolve(target) === path.resolve(lock)) {
        injections++;
        const err = new Error(`${code} from lock mkdir`);
        err.code = code;
        throw err;
      }
      return realMkdirSync.call(this, target, ...args);
    };

    try {
      await historyModule.updateHistory(
        file,
        key,
        { durationSeconds: index + 1, total: null, finishedAt: `t${index + 1}`, exitCode: 0 },
        { timeoutMs: 1000, retryMs: 1, staleMs: 60_000 },
      );
    } finally {
      fs.mkdirSync = realMkdirSync;
    }

    assert.equal(injections, 1);
    assert.deepEqual(loadHistory(file)[key.exact].runs.map((r) => r.durationSeconds), [index + 1]);
    assert.equal(fs.existsSync(lock), false);
  }
});

test('updateHistory times out instead of spinning when lock mkdir keeps returning EPERM', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const lock = historyLockPath(file);
  const realMkdirSync = fs.mkdirSync;
  let attempts = 0;

  fs.mkdirSync = function mkdirWithPersistentLockPermissionError(target, ...args) {
    if (path.resolve(target) === path.resolve(lock)) {
      attempts++;
      if (attempts > 200) throw new Error('hot spin exceeded retry bound');
      const err = new Error('persistent lock mkdir EPERM');
      err.code = 'EPERM';
      throw err;
    }
    return realMkdirSync.call(this, target, ...args);
  };

  const startedAt = Date.now();
  try {
    await assert.rejects(
      historyModule.updateHistory(
        file,
        commandKey(['make']),
        { durationSeconds: 1, total: null, finishedAt: 't1', exitCode: 0 },
        { timeoutMs: 20, retryMs: 2, staleMs: 60_000 },
      ),
      /Timed out waiting for history lock/,
    );
  } finally {
    fs.mkdirSync = realMkdirSync;
  }

  assert.ok(attempts > 1, 'persistent transient mkdir errors should be retried');
  assert.ok(attempts < 200, 'persistent transient mkdir errors must not hot spin');
  assert.ok(Date.now() - startedAt < 1000, 'timeout should stay bounded');
  assert.equal(fs.existsSync(lock), false);
});

test('updateHistory timeout still applies when a stale lock is repeatedly replaced', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const lock = historyLockPath(file);
  const realMkdirSync = fs.mkdirSync;
  let attempts = 0;

  fs.mkdirSync = function mkdirWithRepeatedReplacement(target, ...args) {
    if (path.resolve(target) === path.resolve(lock)) {
      attempts++;
      if (attempts > 200) throw new Error('stale recovery hot spin exceeded retry bound');
      realMkdirSync.call(this, target);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(target, old, old);
      const err = new Error('replacement lock won the race');
      err.code = 'EEXIST';
      throw err;
    }
    return realMkdirSync.call(this, target, ...args);
  };

  const startedAt = Date.now();
  try {
    await assert.rejects(
      historyModule.updateHistory(
        file,
        commandKey(['make']),
        { durationSeconds: 1, total: null, finishedAt: 't1', exitCode: 0 },
        { timeoutMs: 20, retryMs: 2, staleMs: 0 },
      ),
      /Timed out waiting for history lock/,
    );
  } finally {
    fs.mkdirSync = realMkdirSync;
    fs.rmSync(lock, { recursive: true, force: true });
  }

  assert.ok(attempts > 1, 'replacement locks should be retried');
  assert.ok(attempts < 200, 'repeated stale recovery must not hot spin');
  assert.ok(Date.now() - startedAt < 1000, 'timeout should stay bounded');
});

test('updateHistory propagates unexpected lock mkdir errors', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const lock = historyLockPath(file);
  const realMkdirSync = fs.mkdirSync;
  let injected = false;

  fs.mkdirSync = function mkdirWithUnexpectedLockError(target, ...args) {
    if (!injected && path.resolve(target) === path.resolve(lock)) {
      injected = true;
      const err = new Error('unexpected lock mkdir failure');
      err.code = 'EINVAL';
      throw err;
    }
    return realMkdirSync.call(this, target, ...args);
  };

  try {
    await assert.rejects(
      historyModule.updateHistory(
        file,
        commandKey(['make']),
        { durationSeconds: 1, total: null, finishedAt: 't1', exitCode: 0 },
        { timeoutMs: 1000, retryMs: 1, staleMs: 60_000 },
      ),
      /unexpected lock mkdir failure/,
    );
  } finally {
    fs.mkdirSync = realMkdirSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(lock), false);
});

test('updateHistory stale holder fails without removing a replacement lock after takeover', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const lock = historyLockPath(file);
  const key = commandKey(['make']);
  const firstGate = new SharedArrayBuffer(4);
  const secondGate = new SharedArrayBuffer(4);
  const first = startBlockingHistoryWorker({
    file,
    key,
    durationSeconds: 1,
    opts: { timeoutMs: 1000, retryMs: 1, staleMs: 60_000 },
    gate: firstGate,
  });
  let second = null;
  const firstDone = waitForWorker(first);
  let secondDone = Promise.resolve();

  try {
    await waitForWorkerEvent(first, 'save-started');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);

    second = startBlockingHistoryWorker({
      file,
      key,
      durationSeconds: 2,
      opts: { timeoutMs: 1000, retryMs: 1, staleMs: 10 },
      gate: secondGate,
    });
    secondDone = waitForWorker(second);
    await waitForWorkerEvent(second, 'save-started');

    openWorkerGate(firstGate);
    await assert.rejects(firstDone, /Lost history lock ownership/);

    assert.equal(fs.existsSync(lock), true, 'the stale first holder must not remove the replacement lock');
  } finally {
    openWorkerGate(firstGate);
    openWorkerGate(secondGate);
    await Promise.allSettled([firstDone, secondDone]);
  }
});

test('updateHistory times out without disturbing an active sibling lock', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const lock = historyLockPath(file);
  fs.mkdirSync(lock);

  await assert.rejects(
    historyModule.updateHistory(
      file,
      commandKey(['make']),
      { durationSeconds: 1, total: null, finishedAt: 't1', exitCode: 0 },
      { timeoutMs: 40, retryMs: 5, staleMs: 60_000 },
    ),
    /Timed out waiting for history lock/,
  );

  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(file), false);
  fs.rmdirSync(lock);
});

test('updateHistory removes its sibling lock after a successful update', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');

  await historyModule.updateHistory(
    file,
    commandKey(['make']),
    { durationSeconds: 1, total: null, finishedAt: 't1', exitCode: 0 },
    { timeoutMs: 1000, retryMs: 1, staleMs: 60_000 },
  );

  assert.equal(fs.existsSync(historyLockPath(file)), false);
  assert.deepEqual(fs.readdirSync(dir), ['history.json']);
});

test('updateHistory removes its sibling lock when recording throws', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');

  await assert.rejects(
    historyModule.updateHistory(
      file,
      null,
      { durationSeconds: 1, total: null, finishedAt: 't1', exitCode: 0 },
      { timeoutMs: 1000, retryMs: 1, staleMs: 60_000 },
    ),
    /Cannot read/,
  );

  assert.equal(fs.existsSync(historyLockPath(file)), false);
});

test('updateHistory removes its sibling lock when saving throws', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  fs.mkdirSync(file);

  await assert.rejects(
    historyModule.updateHistory(
      file,
      commandKey(['make']),
      { durationSeconds: 1, total: null, finishedAt: 't1', exitCode: 0 },
      { timeoutMs: 1000, retryMs: 1, staleMs: 60_000 },
    ),
  );

  assert.equal(fs.existsSync(historyLockPath(file)), false);
});
