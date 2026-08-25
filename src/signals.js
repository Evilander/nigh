// Tracks counters as per-signal sample series and picks the primary signal.

const KIND_RANK = { fraction: 0, of: 0, percent: 1 };

export function createTracker(opts = {}) {
  const signals = new Map();
  const wantTotal = opts.total ?? null;
  const wantLabel = opts.label ?? null;
  // The signal primary() returned last time, if any: see the stickiness
  // comment on primary() below.
  let stickyKey = null;

  function observe(counters, t) {
    for (const c of counters) {
      if (wantTotal !== null && c.total !== wantTotal) continue;
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
    const top = list[0];
    // Stickiness: a nested inner loop (e.g. outer "file 1/5", inner
    // "chunk 1/100") ranks ahead of the outer one by total desc for the
    // whole of its first cycle, before it has ever reset - resets is tied
    // at 0 for both until then, and the inner one's bigger total wins that
    // tiebreak. Once a signal has been selected, keep it as long as nothing
    // has strictly fewer resets than it (i.e. it is still tied for best on
    // resets); a bigger total or more samples alone must not dethrone it.
    // This only affects repeated primary() calls on the same tracker: any
    // single call still returns the plain top-ranked signal.
    if (stickyKey !== null) {
      const incumbent = signals.get(stickyKey);
      if (incumbent !== undefined && incumbent.resets <= top.resets) {
        return incumbent;
      }
    }
    stickyKey = top.key;
    return top;
  }

  return { observe, primary, all };
}
