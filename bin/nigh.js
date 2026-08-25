#!/usr/bin/env node
// CLI entry: parse flags, then hand the remaining argv off to run().
import { readFileSync, mkdirSync, createWriteStream, openSync, fstatSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeColor, normalizeColorMode } from '../src/render.js';
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
  --bar-color COLOR    color for filled progress bar cells (name, #RRGGBB, or none)
  --track-color COLOR  color for unfilled progress bar cells (name, #RRGGBB, or none)
  --color auto|always|never
                        when to emit ANSI color in the status line (default auto)
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
      case '--bar-color': {
        const value = argv[i + 1];
        if (value === undefined) return { error: '--bar-color requires a COLOR value' };
        opts.barColor = value;
        i += 1;
        break;
      }
      case '--track-color': {
        const value = argv[i + 1];
        if (value === undefined) return { error: '--track-color requires a COLOR value' };
        opts.trackColor = value;
        i += 1;
        break;
      }
      case '--color': {
        const value = argv[i + 1];
        if (value === undefined) return { error: '--color requires auto, always, or never' };
        opts.colorMode = value;
        i += 1;
        break;
      }
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

function applyEnvDefaultsAndValidate(opts, env) {
  try {
    const barColor = opts.barColor ?? env.NIGH_BAR_COLOR;
    if (barColor !== undefined) opts.barColor = normalizeColor(barColor, '--bar-color');

    const trackColor = opts.trackColor ?? env.NIGH_TRACK_COLOR;
    if (trackColor !== undefined) opts.trackColor = normalizeColor(trackColor, '--track-color');

    const colorMode = opts.colorMode ?? (Object.hasOwn(env, 'NO_COLOR') ? 'never' : undefined);
    opts.colorMode = normalizeColorMode(colorMode);
    return null;
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

function readVersion() {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

function openStatusFile(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, 'w');
  return createWriteStream('', { fd, autoClose: true });
}

function openStatusFd(fd) {
  fstatSync(fd);
  // A descriptor can exist but still be read-only. A zero-byte synchronous
  // write checks its access mode without adding bytes to the destination.
  writeSync(fd, Buffer.alloc(0));
  return createWriteStream('', { fd, autoClose: false });
}

function closeOwnedStatusStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }
    stream.end(resolve);
  });
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

  const validationError = applyEnvDefaultsAndValidate(opts, process.env);
  if (validationError) {
    usageError(validationError);
    return;
  }

  let closeStatusStream = false;
  if (opts.statusFile !== undefined) {
    try {
      opts.statusStream = openStatusFile(opts.statusFile);
      opts.statusIsTTY = false;
      closeStatusStream = true;
    } catch (err) {
      process.stderr.write(`nigh: could not open --status-file ${opts.statusFile}: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 2;
      return;
    }
  } else if (opts.statusFd !== undefined) {
    try {
      // autoClose: false - this fd was handed to us open; it is not ours to close.
      opts.statusStream = openStatusFd(opts.statusFd);
      opts.statusIsTTY = isatty(opts.statusFd);
    } catch (err) {
      process.stderr.write(`nigh: could not open --status-fd ${opts.statusFd}: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 2;
      return;
    }
  } else {
    opts.statusIsTTY = Boolean(process.stderr.isTTY);
  }

  try {
    const result = await run(command, opts);
    process.exitCode = result.exitCode;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(`nigh: command not found: ${command[0]}\n`);
      process.exitCode = 127;
    } else if (err && err.code === 'NIGH_USAGE') {
      usageError(err.message);
    } else {
      process.stderr.write(`nigh: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    }
  } finally {
    if (closeStatusStream) await closeOwnedStatusStream(opts.statusStream);
  }
}

main();
