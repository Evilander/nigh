import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_RUNS = 20;

// argv elements are joined as a JSON array rather than space-joined so that
// ['a b', 'c'] and ['a', 'b c'] cannot collide on the same history key.
export function commandKey(argv) {
  const exact = JSON.stringify(argv);
  const shape = JSON.stringify(argv.map((a) => a.replace(/\d+/g, '#')));
  return { exact, shape };
}

export function defaultHistoryPath() {
  if (process.env.NIGH_HISTORY) return process.env.NIGH_HISTORY;
  return path.join(os.homedir(), '.config', 'nigh', 'history.json');
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// A run record straight off disk, cut down to only the fields this version
// recognizes and validated enough that downstream code never has to guard
// against a wrong-shaped value. Fields this version does not recognize (or
// does not have, like an older history file's runs with no exitCode) are
// simply omitted rather than defaulted to a made-up value.
function sanitizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  if (!isFiniteNumber(run.durationSeconds) || run.durationSeconds < 0) return null;
  const out = { durationSeconds: run.durationSeconds };
  out.total = run.total === null || isFiniteNumber(run.total) ? (run.total ?? null) : null;
  out.finishedAt = typeof run.finishedAt === 'string' ? run.finishedAt : null;
  if (isFiniteNumber(run.exitCode)) out.exitCode = run.exitCode;
  return out;
}

// Drops any command-key entry that is not shaped like { runs: [...] }, and
// any individual run within it that does not survive sanitizeRun. A file
// that fails to parse as valid-shaped JSON at all degrades to no history
// rather than throwing partway through a run.
function sanitizeHistory(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.runs)) continue;
    out[key] = { runs: entry.runs.map(sanitizeRun).filter((r) => r !== null) };
  }
  return out;
}

export function loadHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitizeHistory(parsed);
  } catch {
    return {}; // missing or corrupt: start fresh
  }
}

function pushRun(history, key, run) {
  if (!history[key] || !Array.isArray(history[key].runs)) history[key] = { runs: [] };
  const runs = history[key].runs;
  runs.push(run);
  if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS);
}

export function recordRun(history, key, run) {
  pushRun(history, key.exact, run);
  if (key.shape !== key.exact) pushRun(history, key.shape, run);
  return history;
}

function median(seconds) {
  const sorted = [...seconds].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Runs are recorded regardless of outcome (so they're visible for debugging),
// but only exitCode 0 runs feed the prior: a failed or signal-killed run's
// duration says nothing about how long a successful run takes. Older history
// entries with no exitCode field predate this check and are treated as ok.
export function prior(history, key) {
  for (const k of [key.exact, key.shape]) {
    const runs = history[k]?.runs ?? [];
    const durations = runs.filter((r) => (r.exitCode ?? 0) === 0).map((r) => r.durationSeconds);
    if (durations.length > 0) return { medianSeconds: median(durations), n: durations.length };
  }
  return null;
}

export function saveHistory(history, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A unique suffix (pid + random) so two nigh processes finishing around
  // the same time never write the same temp path.
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(history));
  fs.renameSync(tmp, file);
}