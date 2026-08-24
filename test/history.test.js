import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commandKey,
  defaultHistoryPath,
  loadHistory,
  recordRun,
  prior,
  saveHistory,
} from '../src/history.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nigh-history-test-'));
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