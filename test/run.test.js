import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, createSink, killTree } from '../src/run.js';

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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

test(
  'a .cmd target spawns correctly, both via the bare-name retry and named directly',
  { skip: process.platform !== 'win32' },
  async () => {
    const cmdFixture = fixture('counter.cmd');
    const bareName = cmdFixture.replace(/\.cmd$/, ''); // no such file: forces the ENOENT retry path

    const out1 = collectStream();
    const err1 = collectStream();
    const viaRetry = await run([bareName], { historyFile: 'off', stdout: out1, stderr: err1 });
    assert.equal(viaRetry.exitCode, 0);
    assert.equal(out1.text().trim(), '1/1 from-cmd-fixture');

    const out2 = collectStream();
    const err2 = collectStream();
    const viaDirectName = await run([cmdFixture], { historyFile: 'off', stdout: out2, stderr: err2 });
    assert.equal(viaDirectName.exitCode, 0);
    assert.equal(out2.text().trim(), '1/1 from-cmd-fixture');
  },
);

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

test('a final counter with no trailing newline is parsed before the final estimate', async () => {
  const out = collectStream();
  const err = collectStream();
  const result = await run([node, fixture('no-newline.js')], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.exitCode, 0);
  assert.equal(out.text(), '10/10', 'stdout passthrough must still be byte-exact, no newline added');
  assert.equal(result.primary.total, 10);
  assert.equal(result.primary.last.value, 10);
  assert.equal(result.primary.fraction(), 1);
});

test('statusStream keeps stderr as nothing but the child\'s own bytes', async () => {
  const out = collectStream();
  const err = collectStream();
  const status = collectStream();
  const result = await run([node, fixture('stderr-progress.js'), '4', '5'], {
    historyFile: 'off',
    stdout: out,
    stderr: err,
    statusStream: status,
  });
  assert.equal(result.exitCode, 0);
  // stderr-progress.js writes only decoys and "[i/N] step" lines to stderr;
  // none of nigh's own status text (bar characters, "elapsed", "done in") should appear.
  assert.ok(!err.text().includes('elapsed'), 'stderr must not carry nigh\'s own status text');
  assert.ok(err.text().includes('[4/4] step'), 'stderr must still carry the child\'s real output');
  assert.ok(status.text().length > 0, 'the status destination should have received something');
});

test('statusStream + --json produces clean NDJSON with no child bytes interleaved', async () => {
  const out = collectStream();
  const err = collectStream();
  const status = collectStream();
  const result = await run([node, fixture('stderr-progress.js'), '4', '5'], {
    json: true,
    tickMs: 20,
    historyFile: 'off',
    stdout: out,
    stderr: err,
    statusStream: status,
  });
  assert.equal(result.exitCode, 0);
  const events = parseNdjson(status.text()); // throws on any non-JSON line: proves it's clean NDJSON
  assert.ok(events.some((e) => e.event === 'exit'));
  assert.ok(err.text().includes('[4/4] step'), 'the child\'s real stderr output still arrives, just on stderr instead');
});

test('a stdout that throws EPIPE stops the child and reports 141', async () => {
  const err = collectStream();
  let calls = 0;
  const out = {
    isTTY: false,
    write() {
      calls += 1;
      if (calls === 2) {
        const epipe = new Error('write EPIPE');
        epipe.code = 'EPIPE';
        throw epipe;
      }
      return true;
    },
  };
  // A long fixture: if the broken pipe did not end the run, this would take
  // 200 * 20ms rather than stopping at the second write.
  const result = await run([node, fixture('steady.js'), '200', '20'], { historyFile: 'off', stdout: out, stderr: err });
  assert.equal(result.exitCode, 141, 'a broken stdout should end the run with the SIGPIPE status');
  assert.ok(calls >= 2, 'the EPIPE should actually have been hit');
  assert.ok(result.durationSeconds < 3, 'the run should stop at the broken pipe, not play out the fixture');
});

test('killTree terminates the whole process tree, not just the direct child', async () => {
  const pidFile = path.join(os.tmpdir(), `nigh-grandchild-pid-${process.pid}-${Date.now()}.txt`);
  try {
    const child = spawn(node, [fixture('spawns-grandchild.js'), pidFile], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(pidFile), 'grandchild should have announced its pid');
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pidAlive(grandchildPid), 'grandchild should be alive before killTree');

    killTree(child, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500)); // give the OS a moment to reap it

    assert.equal(pidAlive(grandchildPid), false, 'grandchild should not survive killTree');
    assert.equal(pidAlive(child.pid), false, 'the direct child should not survive killTree either');
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test('createSink: a false write() pauses the source, a drain event resumes it', () => {
  let writeReturn = true;
  const written = [];
  const drainHandlers = [];
  const dest = {
    write(chunk) {
      written.push(chunk);
      return writeReturn;
    },
    on(event, handler) {
      if (event === 'drain') drainHandlers.push(handler);
    },
  };
  let paused = false;
  const source = {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    isPaused() {
      return paused;
    },
  };
  const write = createSink(dest, source);
  write('a');
  assert.equal(paused, false);
  writeReturn = false;
  write('b');
  assert.equal(paused, true, 'a false write() return should pause the source');
  drainHandlers.forEach((h) => h());
  assert.equal(paused, false, 'a drain event should resume the source');
  assert.deepEqual(written, ['a', 'b']);
});

test('createSink: an EPIPE error event stops further writes without throwing', () => {
  const errorHandlers = [];
  const written = [];
  const dest = {
    write(chunk) {
      written.push(chunk);
      return true;
    },
    on(event, handler) {
      if (event === 'error') errorHandlers.push(handler);
    },
  };
  const write = createSink(dest);
  write('a');
  const epipe = new Error('write EPIPE');
  epipe.code = 'EPIPE';
  errorHandlers.forEach((h) => h(epipe));
  write('b');
  assert.deepEqual(written, ['a'], 'no further writes should reach the destination after it errors');
});

test('createSink: a synchronously thrown EPIPE is swallowed, not propagated', () => {
  let calls = 0;
  const dest = {
    write() {
      calls += 1;
      const epipe = new Error('write EPIPE');
      epipe.code = 'EPIPE';
      throw epipe;
    },
  };
  const write = createSink(dest);
  assert.doesNotThrow(() => write('a'));
  write('b'); // should be a silent no-op now, not call dest.write() again
  assert.equal(calls, 1);
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
