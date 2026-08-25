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
function cliEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.NIGH_BAR_COLOR;
  delete env.NIGH_TRACK_COLOR;
  delete env.NO_COLOR;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCli(args, { extraFd = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = extraFd ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const child = spawn(node, [binPath, ...args], { stdio, env: cliEnv(env) });
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

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/;

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
  assert.match(r.stdout, /--bar-color COLOR/);
  assert.match(r.stdout, /--track-color COLOR/);
  assert.match(r.stdout, /--color auto\|always\|never/);
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

test('valid color flags color the progress bar even when stderr is piped', async () => {
  const r = await runCli([
    '--bar-color', 'cyan', '--track-color', 'red', '--color', 'always',
    '--history', 'off', '--',
    node, fixture('steady.js'), '5', '150',
  ]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /\x1b\[36m/);
  assert.match(r.stderr, /\x1b\[31m/);
  assert.doesNotMatch(r.stdout, ANSI_RE);
});

test('invalid color flags fail before the child command runs', async () => {
  const marker = tmpFile('invalid-color-ran');
  try {
    const r = await runCli([
      '--bar-color', 'ultraviolet', '--history', 'off', '--',
      node, '-e', "require('node:fs').writeFileSync(process.env.NIGH_TEST_MARKER, 'ran')",
    ], { env: { NIGH_TEST_MARKER: marker } });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /--bar-color.*ultraviolet/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('invalid color modes fail before the child command runs', async () => {
  const marker = tmpFile('invalid-mode-ran');
  try {
    const r = await runCli([
      '--color', 'sometimes', '--history', 'off', '--',
      node, '-e', "require('node:fs').writeFileSync(process.env.NIGH_TEST_MARKER, 'ran')",
    ], { env: { NIGH_TEST_MARKER: marker } });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /--color.*sometimes/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('color env defaults apply, and explicit CLI colors win over env colors', async () => {
  const fromEnv = await runCli([
    '--color', 'always', '--history', 'off', '--',
    node, fixture('steady.js'), '5', '150',
  ], { env: { NIGH_BAR_COLOR: 'yellow', NIGH_TRACK_COLOR: 'blue' } });
  assert.equal(fromEnv.exitCode, 0);
  assert.match(fromEnv.stderr, /\x1b\[33m/);
  assert.match(fromEnv.stderr, /\x1b\[34m/);

  const fromCli = await runCli([
    '--bar-color', 'cyan', '--track-color', 'bright-black', '--color', 'always',
    '--history', 'off', '--',
    node, fixture('steady.js'), '5', '150',
  ], { env: { NIGH_BAR_COLOR: 'yellow', NIGH_TRACK_COLOR: 'blue' } });
  assert.equal(fromCli.exitCode, 0);
  assert.match(fromCli.stderr, /\x1b\[36m/);
  assert.match(fromCli.stderr, /\x1b\[90m/);
  assert.doesNotMatch(fromCli.stderr, /\x1b\[33m/);
  assert.doesNotMatch(fromCli.stderr, /\x1b\[34m/);
});

test('NO_COLOR disables default color, but explicit --color wins', async () => {
  const disabled = await runCli([
    '--bar-color', 'cyan', '--track-color', 'red',
    '--history', 'off', '--',
    node, fixture('steady.js'), '5', '150',
  ], { env: { NO_COLOR: '1' } });
  assert.equal(disabled.exitCode, 0);
  assert.doesNotMatch(disabled.stderr, ANSI_RE);

  const forced = await runCli([
    '--bar-color', 'cyan', '--track-color', 'red', '--color', 'always',
    '--history', 'off', '--',
    node, fixture('steady.js'), '5', '150',
  ], { env: { NO_COLOR: '1' } });
  assert.equal(forced.exitCode, 0);
  assert.match(forced.stderr, /\x1b\[36m/);
  assert.match(forced.stderr, /\x1b\[31m/);
});

test('JSON status stays ANSI-free even when color is forced', async () => {
  const r = await runCli([
    '--json', '--bar-color', 'cyan', '--track-color', 'red', '--color', 'always',
    '--history', 'off', '--',
    node, fixture('steady.js'), '5', '150',
  ]);
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.stderr, ANSI_RE);
  const events = parseNdjson(r.stderr);
  assert.ok(events.some((e) => e.event === 'exit' && e.exitCode === 0));
});

test('--status-file and --status-fd together are rejected', async () => {
  const r = await runCli(['--status-file', 'x', '--status-fd', '3', '--history', 'off', '--', node, '-e', '1']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /cannot both be given/);
});

test('invalid --status-file exits 2 before the child command runs', async () => {
  const dir = tmpFile('status-dir');
  const marker = tmpFile('status-file-ran');
  fs.mkdirSync(dir);
  try {
    const r = await runCli([
      '--status-file', dir, '--history', 'off', '--',
      node, '-e', "require('node:fs').writeFileSync(process.env.NIGH_TEST_MARKER, 'ran')",
    ], { env: { NIGH_TEST_MARKER: marker } });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /could not open --status-file/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }
});

test('invalid --status-fd exits 2 before the child command runs', async () => {
  const marker = tmpFile('status-fd-ran');
  try {
    const r = await runCli([
      '--status-fd', '99', '--history', 'off', '--',
      node, '-e', "require('node:fs').writeFileSync(process.env.NIGH_TEST_MARKER, 'ran')",
    ], { env: { NIGH_TEST_MARKER: marker } });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /could not open --status-fd/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('read-only --status-fd exits 2 before the child command runs', async () => {
  const marker = tmpFile('readonly-status-fd-ran');
  try {
    const r = await runCli([
      '--status-fd', '0', '--history', 'off', '--',
      node, '-e', "require('node:fs').writeFileSync(process.env.NIGH_TEST_MARKER, 'ran')",
    ], { env: { NIGH_TEST_MARKER: marker } });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /could not open --status-fd/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('.cmd newline arguments are reported as usage errors', { skip: process.platform !== 'win32' }, async () => {
  const r = await runCli(['--history', 'off', '--', fixture('echo-arg.cmd'), 'safe\r\nver']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /newlines are not supported/);
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
