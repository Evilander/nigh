// Fixture: prints "[i/N] step" lines every MS ms, interleaved with decoy
// lines (a timestamp, a pid, a byte count, a date) that must not be picked
// up as counters. Usage: steady.js N MS
const n = Number(process.argv[2] ?? 10);
const ms = Number(process.argv[3] ?? 50);

function sleep(t) {
  return new Promise((resolve) => setTimeout(resolve, t));
}

const decoys = [
  () => new Date().toISOString(),
  () => 'pid 1234',
  () => 'wrote 12345 bytes',
  () => '2026/08/24',
];

async function main() {
  for (let i = 1; i <= n; i++) {
    await sleep(ms);
    console.log(decoys[(i - 1) % decoys.length]());
    console.log(`[${i}/${n}] step`);
  }
}

main();
