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

test('commandKey joins argv exactly and digit-collapses for the shape', () => {
  const key = commandKey(['make', '-j8', 'target2']);
  assert.equal(key.exact, 'make -j8 target2');
  assert.equal(key.shape, 'make -j# target#');
});

test('commandKey with no digits has identical exact and shape keys', () => {
  const key = commandKey(['make', 'target']);
  assert.equal(key.exact, 'make target');
  assert.equal(key.shape, key.exact);
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

test('saveHistory creates missing parent directories', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'dirs', 'history.json');
  saveHistory({ a: { runs: [] } }, file);
  assert.deepEqual(loadHistory(file), { a: { runs: [] } });
});

test('saveHistory writes via a .tmp sibling, renames over the file, and leaves no .tmp behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  // Sentinel proves the .tmp sibling is written and renamed away rather than
  // the final file being written directly.
  fs.writeFileSync(`${file}.tmp`, 'sentinel');

  saveHistory({ first: { runs: [] } }, file);
  assert.deepEqual(loadHistory(file), { first: { runs: [] } });
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  saveHistory({ second: { runs: [] } }, file);
  assert.deepEqual(loadHistory(file), { second: { runs: [] } });
});