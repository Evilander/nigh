#!/usr/bin/env node
// CLI entry: parse flags, then hand the remaining argv off to run().
import { readFileSync } from 'node:fs';
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
  --experimental       reserved for bare-number inference (not implemented yet)
  --total N            force the primary counter's total to N
  --label NAME         only track counters labeled NAME
  --ascii              draw the progress bar with plain ASCII characters
  --version             print the version and exit
  --help                print this help and exit
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
        if (!Number.isFinite(value)) return { error: '--interval requires a numeric ms value' };
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
      case '--total': {
        const value = Number(argv[i + 1]);
        if (!Number.isFinite(value)) return { error: '--total requires a numeric value' };
        opts.total = value;
        i += 1;
        break;
      }
      case '--label': {
        const value = argv[i + 1];
        if (value === undefined) return { error: '--label requires a NAME' };
        opts.label = value;
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
