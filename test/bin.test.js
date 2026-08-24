// CLI-level tests for bin/nigh.js: flag parsing, exit codes, and the
// --status-file / --status-fd destinations, none of which src/run.js's own
// tests exercise since they live in the CLI layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const node = process.execPath;
const binPath = path.join(import.meta.dirname, '..', 'bin', 'nigh.js');
const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

function tmpFile(name) {
  return path.join(os.tmpdir(), `nigh-bin-test-${process.pid}-${Date.now()}-${name}`);
}

// Runs nigh itself as a subprocess. extraFd, if given, opens one additional
// pipe (fd 3) so --status-fd has something real to write to.
function runCli(args, { extraFd = false } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = extraFd ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const child = spawn(node, [binPath, ...args], { stdio });
    const out = [];
    const err = [];
    const extra = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    if (extraFd) child.stdio[3].on('data', (c) => extra.push(c));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        extra: Buffer.concat(extra).toString('utf8'),
      });
    });
  });
}

function parseNdjson(text) {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line)); // throws on any invalid line
}

test('--help prints usage and exits 0', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /^usage: nigh /);
});

test('--version prints a version and exits 0', async () => {
  const r = await runCli(['--version']);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('no command prints usage to stderr and exits 2', async () => {
  const r = await runCli([]);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /^usage: nigh /);
});

test('an unknown flag exits 2 with a usage message', async () => {
  const r = await runCli(['--nope']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /unknown flag "--nope"/);
});

test('--interval rejects a negative value', async () => {
  const r = await runCli(['--interval', '-1', '--history', 'off', '--', node, fixture('steady.js'), '1', '5']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /--interval requires a non-negative/);
});

test('--total rejects zero', async () => {
  const r = await runCli(['--total', '0', '--history', 'off', '--', node, fixture('steady.js'), '1', '5']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /--total requires a positive/);
});

test('--status-file and --status-fd together are rejected', async () => {
  const r = await runCli(['--status-file', 'x', '--status-fd', '3', '--history', 'off', '--', node, '-e', '1']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /cannot both be given/);
});

test('--label matches case-insensitively against the (always-lowercase) parsed label', async () => {
  // Files: 3/7 parses to label "files"; --label Files must still select it,
  // which is only observable here via the final summary naming the counter.
  const r = await runCli([
    '--label', 'Files', '--history', 'off', '--',
    node, '-e', "console.log('Files: 3/7')",
  ]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /counter files 3\/7/, 'a matched --label should show up in the final summary');
});

test('--status-file routes status/JSON output to the file, leaving stderr for the child alone', async () => {
  const statusFile = tmpFile('status.json');
  try {
    const r = await runCli([
      '--status-file', statusFile, '--json', '--history', 'off', '--',
      node, fixture('steady.js'), '3', '10',
    ]);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stderr, '', 'stderr should be empty: steady.js only prints to stdout, and status went elsewhere');
    const events = parseNdjson(fs.readFileSync(statusFile, 'utf8'));
    assert.ok(events.some((e) => e.event === 'exit' && e.exitCode === 0));
  } finally {
    fs.rmSync(statusFile, { force: true });
  }
});

test('--status-fd routes status/JSON output to an inherited file descriptor', async () => {
  const r = await runCli(
    ['--status-fd', '3', '--json', '--history', 'off', '--', node, fixture('steady.js'), '3', '10'],
    { extraFd: true },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, '', 'stderr should be empty: steady.js only prints to stdout, and status went to fd 3');
  const events = parseNdjson(r.extra);
  assert.ok(events.some((e) => e.event === 'exit' && e.exitCode === 0));
});
