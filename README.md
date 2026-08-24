# nigh

Run any command and get an ETA from what it already prints.

```
$ nigh -- make -j8
[ 42/120] Building CXX object src/parser.cpp.o
[ 43/120] Building CXX object src/lexer.cpp.o
nigh ▕██████░░░░░░░░░░▏ 36% · 3m10s left (2m40s–4m00s) · 1m48s elapsed · 43/120
```

The command runs unchanged. Its stdout passes through byte for byte, so you can still pipe
it. By default stderr carries the status line and JSON events described below, interleaved
with whatever the command itself writes to stderr; use `--status-file` or `--status-fd`
when you need stderr to be nothing but the command's own bytes. `nigh` reads the same lines
you see, finds the counters a program already prints (`43/120`, `12 of 20`, `45%`), and
keeps a running estimate.

It never guesses from bare numbers. If a program prints nothing that looks like a
counter, the status line says `estimating...` and, on the second run, `about 4m50s (from
history)`, because `nigh` remembers how long each command took last time.

## Install

Node 22 or newer. No dependencies.

```
npm install -g nigh
# or, without installing
npx nigh -- <command>
```

## Usage

```
nigh [options] [--] <command> [args...]

  --json              NDJSON events on stderr instead of the status line
  --quiet             no status line, only the final summary
  --interval MS       how often to print when stderr is not a terminal (default 5000)
  --history FILE      history file (default ~/.config/nigh/history.json); "off" disables it
  --status-file FILE  write the status line / JSON events to FILE instead of stderr
  --status-fd N       like --status-file, but to an already-open file descriptor
  --total N           trust only counters whose total is N (must be > 0)
  --label NAME        trust only counters labelled NAME (the word before the number; case-insensitive)
  --ascii             plain [####----] bar
  --experimental      accepted, no effect yet (bare-number counters are not in this version)
```

`--` separates options from the command. Without it, the first word that does not start
with `-` begins the command.

## What counts as a counter

Three shapes, anywhere in a line, on stdout or stderr, after ANSI colour codes are
stripped and with `\r`-rewritten lines handled:

| shape | examples | not a counter |
|---|---|---|
| fraction | `12/120`, `[12/120]`, `1,200/12,000` | dates (`08/24/2026`), paths (`src/app/3.js`), versions (`v1/2`), decimals (`1.5/2.5`), `13/12` |
| of | `12 of 120`, `Processing item 4 of 20` | |
| percent | `45%`, `45.5 %`, `100%` | `150%` |

The word right before a counter becomes its label (`Epoch 3/10` → `epoch`), which is how
`--label` selects one. Every distinct (shape, label, total) is tracked separately. When a
counter's value drops, that counter is an inner loop and loses priority; the outermost
counter that never resets drives the estimate. Fractions beat percentages when both never
reset, and larger totals beat smaller ones.

## How the estimate is made

Two rates over the chosen counter: the rate since it first appeared, and a Theil–Sen
median slope over the last 20 samples, which ignores a single slow or fast burst. The ETA
blends them (60% recent, 40% overall); the band is the spread between them, widened by how
badly the recent fit predicted the samples it has seen, and never narrower than ±10%.

History is a JSON file keyed by the exact command line and by its shape (digits replaced
by `#`). With no counter yet, the estimate is the median of previous runs. Once a counter
appears, the prior fades out over the first 15% of progress.

## Limits

- Programs that only print progress on a terminal (many progress bars check `isatty`) print
  nothing useful when piped. `nigh` runs the child through pipes, so those show
  `estimating...`. PTY support is the obvious next step and is not in this version.
- `nigh` reports what a counter implies; if a program prints `3/10` and then does an
  unannounced hour of work after `10/10`, the ETA was wrong the way the program was wrong.
- The label comes only from the word(s) immediately before a counter; units or other text
  after it (`12/120 MB`) are not captured, so a bare `12/120 MB` with nothing before it
  gets an empty label.
- Without `--status-file`/`--status-fd`, stderr is not a byte-exact copy of what the command
  would print on its own: the status line, JSON events, and final summary share it,
  interleaved with the command's real stderr output. Only stdout is guaranteed byte-exact
  in every mode.
- If a counter's signal goes quiet for a long stretch relative to its own pace, `nigh`
  widens the band and then falls back to `estimating...` rather than keep reporting a
  frozen, increasingly wrong number.
- `SIGINT`/`SIGTERM` sent to `nigh` are forwarded to the whole process tree it spawned, not
  just the direct child, so a wrapped shell script's own children are also stopped.
- If whatever is reading `nigh`'s stdout goes away (`nigh -- cmd | head -1`), the child's
  process tree is stopped and `nigh` exits `141`, the conventional broken-pipe status — the
  same way the command would have died on its own without a wrapper in the middle.
- Windows: `.cmd` shims are resolved when the plain name is not found.

## Closest tools

`pv` measures bytes through a pipe and needs to be inside the pipeline. `progress` reads
file offsets of coreutils programs from `/proc`. `eta` (aioobe) polls a command and takes
the first number it prints toward a target you supply. `nigh` differs from all three by
reading the counters a program prints on its own, choosing among them, and remembering past
runs.

## Tests

```
npm test
```

`node:test` suites for parsing, signal selection, the estimator (including a synthetic log
bench with steady, accelerating, decelerating and nested scenarios), history, rendering, an
end-to-end run against fixture programs (byte-exact passthrough, exit codes, `\r` progress,
stderr counters, JSON events, history prior, EPIPE/backpressure, process-tree kill), and the
CLI's own flag parsing.

## License

MIT
