#!/usr/bin/env node
// CLI entry: parse flags, then hand the remaining argv off to run().
import { readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../src/run.js';

const HELP = `usage: nigh [options] [--] <command> [args...]

Runs <command> unchanged, tees its output, and prints an ETA derived from
counters (a/b, "a of b", NN%) the command already prints.

Options:
  --json              emit NDJSON progress events on stderr instead of a status line
  --quiet              suppress the periodic status line (the final summary still prints)
  --interval ms        minimum ms between status-line writes when stderr is not a TTY (default 5000)
  --history FILE|off   history file path, or "off" to disable history for this run
  --status-file FILE   write the status line / --json events to FILE instead of stderr,
                        so stderr carries only the wrapped command's own bytes
  --status-fd N        like --status-file, but write to an already-open file descriptor N
  --experimental       reserved for bare-number inference (not implemented yet)
  --total N            force the primary counter's total to N (must be > 0)
  --label NAME         only track counters labeled NAME (case-insensitive)
  --ascii              draw the progress bar with plain ASCII characters
  --version             print the version and exit
  --help                print this help and exit

By default the status line, --json events, and the wrapped command's own
stderr all share stderr, interleaved - so stderr alone is not a byte-exact
copy of what the command would have printed on its own (stdout always is).
Use --status-file or --status-fd for a run where stderr is guaranteed to be
nothing but the command's own bytes.
`;

function usageError(message) {
  process.stderr.write(`nigh: ${message}\n`);
  process.stderr.write('Run "nigh --help" for usage.\n');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const opts = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      i += 1;
      break;
    }
    if (!arg.startsWith('-')) break; // first non-flag token begins the command

    switch (arg) {
      case '--json':
        opts.json = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--experimental':
        opts.experimental = true;
        break;
      case '--ascii':
        opts.ascii = true;
        break;
      case '--version':
        opts.version = true;
        break;
      case '--help':
        opts.help = true;
        break;
      case '--interval': {
        const value = Number(argv[i + 1]);
        if (!Number.isFinite(value) || value < 0) return { error: '--interval requires a non-negative numeric ms value' };
        opts.intervalMs = value;
        i += 1;
        break;
      }
      case '--history': {
        const value = argv[i + 1];
        if (value === undefined) return { error: '--history requires a FILE path or "off"' };
        opts.historyFile = value;
        i += 1;
        break;
      }
      case '--status-file': {
        const value = argv[i + 1];
        if (value === undefined) return { error: '--status-file requires a FILE path' };
        if (opts.statusFd !== undefined) return { error: '--status-file and --status-fd cannot both be given' };
        opts.statusFile = value;
        i += 1;
        break;
      }
      case '--status-fd': {
        const value = Number(argv[i + 1]);
        if (!Number.isInteger(value) || value < 0) return { error: '--status-fd requires a non-negative integer file descriptor' };
        if (opts.statusFile !== undefined) return { error: '--status-file and --status-fd cannot both be given' };
        opts.statusFd = value;
        i += 1;
        break;
      }
      case '--total': {
        const value = Number(argv[i + 1]);
        if (!Number.isFinite(value) || value <= 0) return { error: '--total requires a positive numeric value' };
        opts.total = value;
        i += 1;
        break;
      }
      case '--label': {
        const value = argv[i + 1];
        if (value === undefined) return { error: '--label requires a NAME' };
        opts.label = value.toLowerCase(); // parsed labels are always lowercased; match that here
        i += 1;
        break;
      }
      default:
        return { error: `unknown flag "${arg}"` };
    }
  }
  return { opts, command: argv.slice(i) };
}

function readVersion() {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

async function main() {
  const { opts, command, error } = parseArgs(process.argv.slice(2));
  if (error) {
    usageError(error);
    return;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    process.exitCode = 0;
    return;
  }
  if (opts.version) {
    process.stdout.write(`${readVersion()}\n`);
    process.exitCode = 0;
    return;
  }
  if (command.length === 0) {
    process.stderr.write(HELP);
    process.exitCode = 2;
    return;
  }
  if (opts.experimental) {
    process.stderr.write('nigh: warning: --experimental bare-counter mode is not implemented yet; ignoring.\n');
  }

  if (opts.statusFile !== undefined) {
    try {
      mkdirSync(path.dirname(opts.statusFile), { recursive: true });
      opts.statusStream = createWriteStream(opts.statusFile);
    } catch (err) {
      process.stderr.write(`nigh: could not open --status-file ${opts.statusFile}: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 2;
      return;
    }
  } else if (opts.statusFd !== undefined) {
    try {
      // autoClose: false - this fd was handed to us open; it is not ours to close.
      opts.statusStream = createWriteStream('', { fd: opts.statusFd, autoClose: false });
    } catch (err) {
      process.stderr.write(`nigh: could not open --status-fd ${opts.statusFd}: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 2;
      return;
    }
  }

  try {
    const result = await run(command, opts);
    process.exitCode = result.exitCode;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(`nigh: command not found: ${command[0]}\n`);
      process.exitCode = 127;
    } else {
      process.stderr.write(`nigh: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    }
  }
}

main();
