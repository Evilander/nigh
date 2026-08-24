// Tracks counters as per-signal sample series and picks the primary signal.

const KIND_RANK = { fraction: 0, of: 0, percent: 1 };

export function createTracker(opts = {}) {
  const signals = new Map();
  const wantTotal = opts.total ?? null;
  const wantLabel = opts.label ?? null;

  function observe(counters, t) {
    for (const c of counters) {
      if ((c.kind === 'fraction' || c.kind === 'of') && wantTotal !== null && c.total !== wantTotal) continue;
      if (wantLabel !== null && c.label !== wantLabel) continue;
      const key = `${c.kind}:${c.label}:${c.total}`;
      let s = signals.get(key);
      if (s === undefined) {
        s = {
          key,
          kind: c.kind,
          label: c.label,
          total: c.total,
          samples: [],
          resets: 0,
          first: null,
          last: null,
          fraction() {
            const v = this.samples[this.samples.length - 1].value;
            return this.kind === 'percent' ? v / 100 : v / this.total;
          },
        };
        signals.set(key, s);
      } else if (c.value < s.samples[s.samples.length - 1].value) {
        // Progress went backwards: start a fresh cycle with the new sample.
        s.resets += 1;
        s.samples = [];
      }
      s.samples.push({ t, value: c.value });
      s.first = s.samples[0];
      s.last = s.samples[s.samples.length - 1];
    }
  }

  function all() {
    return [...signals.values()];
  }

  function primary() {
    const list = all();
    if (list.length === 0) return null;
    list.sort((a, b) =>
      a.resets - b.resets ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      b.total - a.total ||
      b.samples.length - a.samples.length ||
      b.last.t - a.last.t ||
      a.first.t - b.first.t
    );
    return list[0];
  }

  return { observe, primary, all };
}
