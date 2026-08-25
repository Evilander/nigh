import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_RUNS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_OWNER_PREFIX = 'owner-';
const LOCK_OWNER_SUFFIX = '.json';

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

function historyLockPath(file) {
  return `${file}.lock`;
}

function lockToken() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function lockOwnerFile(lockPath, token) {
  return path.join(lockPath, `${LOCK_OWNER_PREFIX}${token}${LOCK_OWNER_SUFFIX}`);
}

function optionMs(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isLockBusyError(err) {
  return err?.code === 'EEXIST' || err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY';
}

function ownerTokenFromFile(name) {
  if (!name.startsWith(LOCK_OWNER_PREFIX) || !name.endsWith(LOCK_OWNER_SUFFIX)) return null;
  return name.slice(LOCK_OWNER_PREFIX.length, -LOCK_OWNER_SUFFIX.length);
}

function inspectLock(lockPath) {
  let entries;
  try {
    entries = fs.readdirSync(lockPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false };
    if (err?.code !== 'ENOTDIR') throw err;
  }

  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false };
    throw err;
  }

  if (!stat.isDirectory()) return { exists: true, kind: 'file', mtimeMs: stat.mtimeMs };

  return {
    exists: true,
    kind: 'directory',
    mtimeMs: stat.mtimeMs,
    owners: entries
      .map((entry) => ownerTokenFromFile(entry))
      .filter((token) => token !== null),
  };
}

function recoverStaleLock(lockPath, staleMs) {
  let lock;
  try {
    lock = inspectLock(lockPath);
  } catch (err) {
    // Windows can transiently report EPERM/EACCES while another process is
    // creating or removing the lock directory. Treat that as a busy lock and
    // retry instead of failing the history update.
    if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY') return 'busy';
    throw err;
  }
  if (!lock.exists) return 'absent';

  if (Date.now() - lock.mtimeMs < staleMs) return 'busy';

  try {
    if (lock.kind === 'file') {
      fs.unlinkSync(lockPath);
      return 'recovered';
    }

    for (const token of lock.owners) {
      try {
        fs.unlinkSync(lockOwnerFile(lockPath, token));
      } catch (err) {
        if (err?.code !== 'ENOENT') return 'busy';
      }
    }

    const current = inspectLock(lockPath);
    if (!current.exists) return 'recovered';
    if (Date.now() - current.mtimeMs < staleMs) return 'busy';

    fs.rmdirSync(lockPath);
    return 'recovered';
  } catch (err) {
    if (err?.code === 'ENOENT') return 'recovered';
    return 'busy';
  }
}

function tryAcquireHistoryLock(lockPath) {
  const token = lockToken();

  try {
    fs.mkdirSync(lockPath);
  } catch (err) {
    if (isLockBusyError(err)) return null;
    throw err;
  }

  const ownerPath = lockOwnerFile(lockPath, token);
  try {
    fs.writeFileSync(
      ownerPath,
      JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }),
      { flag: 'wx' },
    );
  } catch (err) {
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // If cleanup fails, surface the original metadata write failure.
    }
    throw err;
  }

  return { path: lockPath, token, ownerPath };
}

async function acquireHistoryLock(lockPath, opts = {}) {
  const timeoutMs = optionMs(opts.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryMs = optionMs(opts.retryMs, DEFAULT_LOCK_RETRY_MS);
  const staleMs = optionMs(opts.staleMs, DEFAULT_STALE_LOCK_MS);
  const startedAt = Date.now();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    const lock = tryAcquireHistoryLock(lockPath);
    if (lock) return lock;

    const recovery = recoverStaleLock(lockPath, staleMs);

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`Timed out waiting for history lock: ${lockPath}`);
    }
    const waitMs = recovery === 'recovered' ? 0 : Math.min(retryMs, timeoutMs - elapsedMs);
    await delay(waitMs);
  }
}

function assertOwnsHistoryLock(lock) {
  try {
    fs.accessSync(lock.ownerPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`Lost history lock ownership: ${lock.path}`);
    }
    throw err;
  }
}

function releaseHistoryLock(lock) {
  try {
    fs.unlinkSync(lock.ownerPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }

  try {
    fs.rmdirSync(lock.path);
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTEMPTY') throw err;
  }
}

function saveHistoryWithLock(history, file, lock) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(history));
    assertOwnsHistoryLock(lock);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The original save/ownership error is more useful to the caller.
    }
    throw err;
  }
}

export async function updateHistory(file, key, run, opts = {}) {
  const lockPath = historyLockPath(file);
  const lock = await acquireHistoryLock(lockPath, opts);

  let updateError = null;
  try {
    const history = loadHistory(file);
    const updated = recordRun(history, key, run);
    saveHistoryWithLock(updated, file, lock);
    return updated;
  } catch (err) {
    updateError = err;
    throw err;
  } finally {
    try {
      releaseHistoryLock(lock);
    } catch (releaseErr) {
      if (!updateError) throw releaseErr;
    }
  }
}
