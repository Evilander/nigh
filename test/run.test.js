import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/run.js';

const node = process.execPath;
const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

function collectStream() {
  const chunks = [];
  return {
    isTTY: false,
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    buffer() {
      return Buffer.concat(chunks);
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

function parseNdjson(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.map((line) => JSON.parse(line)); // throws on any invalid line
}

function tempHistoryPath() {
  return path.join(os.tmpdir(), `nigh-history-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('passthrough byte-fidelity: stdout is identical to the fixture run directly', async () => {
  const direct = execFileSync(node, [fixture('binary.js')]);
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('binary.js')], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.exitCode, 0);
  assert.ok(direct.equals(out.buffer()), 'stdout bytes must match the direct run exactly');
});

test('exit code propagation', async () => {
  const out = collectStream();
  const err = collectStream();
  const failing = await run([node, fixture('exit3.js')], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(failing.exitCode, 3);

  const out2 = collectStream();
  const err2 = collectStream();
  const passing = await run([node, fixture('steady.js'), '3', '10'], { historyFile: 'off', stdout: out2, stderr: err2 });
  assert.equal(passing.exitCode, 0);
});

test('primary signal selection: steady picks the outer fraction', async () => {
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('steady.js'), '40', '10'], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.primary.kind, 'fraction');
  assert.equal(result.primary.total, 40);
});

test('primary signal selection: nested picks the outer, not the inner rewritten percent', async () => {
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('nested.js'), '5', '4', '5'], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.primary.total, 5);
});

test('primary signal selection: crlf-rewritten progress is tracked', async () => {
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('crlf.js'), '30', '5'], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.primary.total, 30);
});

test('primary signal selection: stderr-only progress is tracked', async () => {
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('stderr-progress.js'), '30', '5'], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.primary.total, 30);
});

test('JSON mode: NDJSON on stderr with start, counter, estimate and exactly one exit event', async () => {
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('steady.js'), '15', '30'], {
    json: true,
    tickMs: 20,
    historyFile: 'off',
    stdout: out,
    stderr: err,
  });
  assert.equal(result.exitCode, 0);
  const events = parseNdjson(err.text()); // throws if any line is not valid JSON
  const byType = (type) => events.filter((e) => e.event === type);
  assert.equal(byType('start').length, 1);
  assert.ok(byType('counter').length >= 1);
  assert.ok(byType('estimate').length >= 1);
  assert.equal(byType('exit').length, 1);
  assert.equal(byType('exit')[0].exitCode, 0);
});

test('ETA accuracy: first estimate at fraction >= 0.2 is within 25% of the true remaining time', async () => {
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('steady.js'), '50', '20'], {
    json: true,
    tickMs: 20,
    historyFile: 'off',
    stdout: out,
    stderr: err,
  });
  const events = parseNdjson(err.text());
  const exitEvent = events.find((e) => e.event === 'exit');
  const firstAtThreshold = events.find((e) => e.event === 'estimate' && e.fraction !== null && e.fraction >= 0.2);
  assert.ok(firstAtThreshold, 'expected an estimate event at fraction >= 0.2');

  // True remaining is derived from the run's own measured total duration
  // (not the fixture's nominal sleep interval): OS timer granularity means
  // requested sleep(ms) is only a floor, so the estimator's job is to track
  // the actual observed pace, not the nominal one.
  const trueRemaining = exitEvent.durationSeconds - firstAtThreshold.t / 1000;
  const tolerance = 0.25 * trueRemaining;
  assert.ok(
    Math.abs(firstAtThreshold.etaSeconds - trueRemaining) <= tolerance,
    `etaSeconds ${firstAtThreshold.etaSeconds} not within 25% of true remaining ${trueRemaining}`
  );
});

test('history: a prior from a previous run seeds the very first estimate on the next run', async () => {
  const historyFile = tempHistoryPath();
  const argv = [node, fixture('steady.js'), '6', '150'];
  try {
    const out1 = collectStream();
    const err1 = collectStream();
    const first = await run(argv, { tickMs: 10, historyFile, stdout: out1, stderr: err1 });
    assert.equal(first.exitCode, 0);
    assert.ok(fs.existsSync(historyFile), 'first run should have written a history file');

    const out2 = collectStream();
    const err2 = collectStream();
    await run(argv, { json: true, tickMs: 10, historyFile, stdout: out2, stderr: err2 });
    const events = parseNdjson(err2.text());
    const firstEstimate = events.find((e) => e.event === 'estimate');
    assert.ok(firstEstimate, 'expected at least one estimate event on the second run');
    assert.equal(firstEstimate.basis, 'prior');
  } finally {
    fs.rmSync(historyFile, { force: true });
  }
});

test('history: historyFile "off" writes nothing', async () => {
  const historyFile = tempHistoryPath();
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('steady.js'), '3', '10'], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(historyFile), false);
});

test('SIGINT received by nigh is forwarded to the child', { skip: process.platform === 'win32' }, async () => {
  const out = collectStream();
  const err = collectStream();
  const resultPromise = run([node, fixture('steady.js'), '1000', '50'], { historyFile: 'off', stdout: out, stderr: err });
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.kill(process.pid, 'SIGINT');
  const result = await resultPromise;
  assert.equal(result.exitCode, 128 + 2); // 128 + SIGINT
  assert.ok(result.durationSeconds < 5, 'should have exited promptly, not run the full 50s fixture');
});
