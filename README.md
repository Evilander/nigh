# nigh

`nigh` wraps a command, watches the progress counters it already prints, and
estimates how much time remains. The command does not need to know that `nigh`
is there.

```text
$ nigh -- make -j8
[ 42/120] Building CXX object src/parser.cpp.o
[ 43/120] Building CXX object src/lexer.cpp.o
nigh ▕██████░░░░░░░░░░▏ 36% · 3m10s left (2m40s-4m00s) · 1m48s elapsed · 43/120
```

The wrapped command's stdout passes through byte for byte, so piping still
works. `nigh` reads both stdout and stderr for counters such as `43/120`,
`12 of 20`, and `45%`. If no counter appears, it can use the duration of earlier
runs as a rough starting estimate.

## Install

`nigh` requires Node.js 22 or newer. It has no runtime dependencies.

Install the current version directly from GitHub:

```sh
npm install --global github:evilander/nigh
```

Or clone it and create a local global link while developing:

```sh
git clone https://github.com/evilander/nigh.git
cd nigh
npm link
```

Either route installs the `nigh` command.

## Use it

Put `--` before the command when its arguments may look like `nigh` options:

```sh
nigh -- npm test
nigh --total 500 -- ./process-files input/
nigh --label epoch -- python train.py
```

Without `--`, the first argument that does not begin with `-` starts the wrapped
command.

```text
nigh [options] [--] <command> [args...]

  --json              write NDJSON events instead of a status line
  --quiet             hide periodic updates; still write the final summary
  --interval MS       non-terminal update interval in ms (default: 5000)
  --history FILE      history path; use "off" to disable history
  --status-file FILE  send nigh's output to a file instead of stderr
  --status-fd N       send nigh's output to an already-open file descriptor
  --total N           only use counters whose total is N
  --label NAME        only use counters with this label
  --ascii             draw [####----] instead of the Unicode bar
  --bar-color COLOR   color for the completed part of the bar
  --track-color COLOR color for the unfinished part of the bar
  --color MODE        auto, always, or never
  --experimental      reserved; currently has no effect
  --version           print the version
  --help              print help
```

`--total` must be greater than zero. Labels are matched without regard to
capitalization.

## Choose the bar colors

The default output remains uncolored. Set either part independently:

```sh
nigh --bar-color cyan --track-color bright-black -- npm test
nigh --bar-color '#ff7a18' --track-color '#3a3a3a' -- npm test
```

Colors may be `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`,
`white`, any `bright-` version of those names, `gray`/`grey`, `none`, or a
six-digit RGB value such as `#7c3aed`.

`--color auto` enables configured colors only when the status destination is a
terminal. `always` forces them on and `never` disables them. An explicit
`--color` option takes precedence over `NO_COLOR`; otherwise `NO_COLOR`
disables color.

For a reusable theme, set environment variables instead:

```sh
NIGH_BAR_COLOR=cyan NIGH_TRACK_COLOR=bright-black nigh -- npm test
```

In PowerShell:

```powershell
$env:NIGH_BAR_COLOR = 'cyan'
$env:NIGH_TRACK_COLOR = 'bright-black'
nigh -- npm test
```

Command-line colors override `NIGH_BAR_COLOR` and `NIGH_TRACK_COLOR`. JSON mode
never contains terminal color codes.

## What nigh recognizes

| Form | Examples | Rejected examples |
| --- | --- | --- |
| Fraction | `12/120`, `[12/120]`, `1,200/12,000` | dates, paths, versions, decimals, or a value larger than its total |
| "of" counter | `12 of 120`, `Processing item 4 of 20` | a value larger than its total |
| Percent | `45%`, `45.5 %`, `100%` | `150%` |

ANSI escape codes are removed before parsing, and progress lines rewritten with
carriage returns are handled. Bare numbers are ignored because treating every
number in normal command output as progress would produce misleading ETAs.

The one or two words immediately before a counter become its label. For
example, `Epoch 3/10` has the label `epoch`. Each distinct combination of form,
label, and total is tracked separately. A counter that repeatedly resets is
treated as an inner loop; a stable outer counter is preferred.

## Status output and piping

By default, the status line and the wrapped command's own stderr share stderr.
Stdout remains byte-exact in every mode, but stderr does not. Keep them separate
when another program needs clean stderr:

```sh
nigh --status-file ./progress.log -- command-that-uses-stderr
```

`--status-fd N` does the same thing with an already-open file descriptor. An
invalid status file or descriptor is rejected before the wrapped command is
started.

When the consumer of the wrapped command's stdout or stderr disappears early,
as in `nigh -- command | head -1`, `nigh` stops the wrapped process tree and
exits with status 141. Failure of a separate status-only destination does not
stop the command. On POSIX, `SIGINT` and `SIGTERM` are sent to the process group
first, with a forced stop if it does not exit. Windows process-tree termination
uses `taskkill`, which is forceful rather than graceful.

## JSON events

`--json` replaces the status line with newline-delimited JSON events. Use a
separate status destination if the child may write to stderr; otherwise those
bytes and the JSON events are interleaved and the result is not clean NDJSON.

```sh
nigh --json --status-file ./progress.ndjson -- npm test
```

The event types are:

- `start`: `event`, `argv`, `pid`, and elapsed milliseconds `t`
- `counter`: `event`, the parsed `line`, `counters`, and `t`
- `estimate`: `event`, `fraction`, `etaSeconds`, `lowSeconds`, `highSeconds`,
  `basis`, and `t`
- `exit`: `event`, `exitCode`, and `durationSeconds`

Each counter has `kind`, `value`, `total`, `label`, and the matched `raw` text.
Unknown estimates use `null` rather than an invented number.

The JSON stream can contain the complete command line and raw command output.
Do not publish it without checking for credentials, private paths, or other
sensitive data.

## History and estimates

History defaults to `~/.config/nigh/history.json`. Override it with
`--history FILE` or `NIGH_HISTORY`, or disable it for one run with
`--history off`.

History is keyed by the exact argument list and by a generalized form with
digits replaced. It records the last 20 runs per key. Only successful runs feed
future estimates, and concurrent `nigh` processes safely merge their results.

Because the exact arguments are stored, prefer environment variables over
command-line secrets. Use `--history off` when even the argument list should
not be retained.

Once a counter is moving, `nigh` compares its overall rate with a median recent
rate and shows a range when they disagree. A historical estimate fades out as
live progress becomes useful. If a counter goes quiet for too long, the range
widens and eventually returns to `estimating...` instead of pretending a stale
ETA is still trustworthy.

## Limits

- Programs that only draw progress when attached directly to a terminal may
  show `estimating...`; `nigh` does not provide a pseudo-terminal.
- The estimate can only account for progress the command reports. Hidden work
  after a displayed `100%` cannot be predicted.
- A label comes from text before the counter. Units written after a counter,
  such as `12/120 MB`, are not part of the label.
- Windows `.cmd` and `.bat` shims are supported, but Windows signal handling is
  necessarily different from POSIX process-group signaling. For safety,
  newline characters in arguments passed to a batch file are rejected.

## Development

```sh
npm test
npm pack --dry-run
```

The test suite covers counter parsing, ETA behavior, nested progress, history,
rendering, backpressure, output separation, process-tree termination, CLI
validation, and end-to-end execution.

## License

MIT © 2026 Tyler Eveland
