import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_RUNS = 20;

export function commandKey(argv) {
  const exact = argv.join(' ');
  return { exact, shape: exact.replace(/\d+/g, '#') };
}

export function defaultHistoryPath() {
  if (process.env.NIGH_HISTORY) return process.env.NIGH_HISTORY;
  return path.join(os.homedir(), '.config', 'nigh', 'history.json');
}

export function loadHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // missing or corrupt: start fresh
  }
}

function pushRun(history, key, run) {
  if (!history[key]) history[key] = { runs: [] };
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

export function prior(history, key) {
  for (const k of [key.exact, key.shape]) {
    const durations = history[k]?.runs?.map((r) => r.durationSeconds) ?? [];
    if (durations.length > 0) return { medianSeconds: median(durations), n: durations.length };
  }
  return null;
}

export function saveHistory(history, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history));
  fs.renameSync(tmp, file);
}